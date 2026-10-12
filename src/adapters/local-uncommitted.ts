import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import {
  ATTRIBUTE_NEUTRAL_DIFF_FLAGS,
  BLOB_SNIFF_MAX_BYTES,
  contentBinaryPaths,
} from "../shared/repo.js";
import type { UntrackedSkippedFile } from "../shared/schema.js";

export const EMPTY_BASE_SHA = "EMPTY";
export const WORKING_HEAD_SHA = "WORKING";

const MAX_UNTRACKED_FILE_BYTES = 200 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 1024 * 1024;

export interface UntrackedPatch {
  readonly patch: string;
  readonly patchStat: string;
  readonly paths: readonly string[];
  readonly skipped: readonly string[];
  readonly untrackedSkipped: readonly UntrackedSkippedFile[];
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

/**
 * Changed tracked paths (vs HEAD) whose content is binary on either side,
 * judged by content, not by .gitattributes: the work-tree file when present,
 * and the HEAD blob. Input order is preserved so skip lists stay stable.
 */
export function workingBinaryPaths(
  cwd: string,
  headRef: string,
  paths: readonly string[]
): string[] {
  const flagged = new Set<string>();
  const notFlagged: string[] = [];
  for (const filePath of paths) {
    let stat: Stats | undefined;
    try {
      stat = lstatSync(path.join(cwd, filePath));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    if (
      stat?.isFile() &&
      (stat.size > BLOB_SNIFF_MAX_BYTES || isBinary(readFileSync(path.join(cwd, filePath))))
    ) {
      flagged.add(filePath);
    } else {
      notFlagged.push(filePath);
    }
  }
  for (const filePath of contentBinaryPaths(cwd, headRef, headRef, notFlagged)) {
    flagged.add(filePath);
  }
  return paths.filter((filePath) => flagged.has(filePath));
}

function countInsertions(patch: string): number {
  let insertions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) insertions += 1;
  }
  return insertions;
}

/** Real `git diff --no-index` for an untracked file. Exit 1 + stdout = success. */
function gitNewFileDiff(
  cwd: string,
  filePath: string
): { readonly patch: string; readonly insertions: number } {
  const res = spawnSync(
    "git",
    ["diff", "--no-index", ...ATTRIBUTE_NEUTRAL_DIFF_FLAGS, "--no-color", "--", "/dev/null", filePath],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 64,
    }
  );
  if (res.error) throw res.error;
  // Do not trim: trailing newline must survive for git apply.
  const stdout = res.stdout ?? "";
  if (res.status === 0) {
    throw new Error(`git diff --no-index produced no diff for ${filePath}`);
  }
  if (res.status !== 1 || stdout.length === 0) {
    throw new Error(
      `git diff --no-index -- /dev/null ${filePath} failed: ${(res.stderr ?? "").slice(0, 2000)}`
    );
  }
  return { patch: stdout, insertions: countInsertions(stdout) };
}

function statLine(filePath: string, insertions: number): string {
  const pluses = "+".repeat(Math.min(insertions, 40));
  return ` ${filePath} | ${insertions} ${pluses}`;
}

/** ENOENT only (dangling/missing). EACCES and other I/O errors stay fail-closed. */
function isMissingPathError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function buildUntrackedPatch(cwd: string, files: readonly string[]): UntrackedPatch {
  const patches: string[] = [];
  const statLines: string[] = [];
  const paths: string[] = [];
  const skipped: string[] = [];
  const untrackedSkipped: UntrackedSkippedFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const absolutePath = path.join(cwd, file);
    // lstat does not follow; a dangling symlink must not abort the whole review.
    let stat: Stats | undefined;
    try {
      stat = lstatSync(absolutePath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    if (stat === undefined || !stat.isFile()) {
      skipped.push(`${file} (not a regular file)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      skipped.push(`${file} (over 200KB)`);
      untrackedSkipped.push({ path: file, bytes: stat.size, reason: "per_file_cap" });
      continue;
    }
    let content: Buffer;
    try {
      content = readFileSync(absolutePath);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      skipped.push(`${file} (not a regular file)`);
      continue;
    }
    if (content.byteLength === 0) {
      skipped.push(`${file} (empty)`);
      continue;
    }
    if (isBinary(content)) {
      skipped.push(`${file} (binary)`);
      continue;
    }
    if (totalBytes + content.byteLength > MAX_UNTRACKED_TOTAL_BYTES) {
      skipped.push(`${file} (total untracked content cap 1MB)`);
      untrackedSkipped.push({ path: file, bytes: content.byteLength, reason: "total_cap" });
      continue;
    }
    const diff = gitNewFileDiff(cwd, file);
    totalBytes += content.byteLength;
    patches.push(diff.patch);
    statLines.push(statLine(file, diff.insertions));
    paths.push(file);
  }

  return {
    patch: patches.join(""),
    patchStat: statLines.join("\n"),
    paths,
    skipped,
    untrackedSkipped,
  };
}

export function joinSections(parts: readonly string[]): string {
  return parts.filter((part) => part.trim()).join("\n");
}

export function formatUncommittedReviewTarget(
  pr: number | undefined,
  skippedUntracked: readonly string[],
  skippedTracked: readonly string[] = []
): string {
  const lines = ["Review target: uncommitted changes"];
  if (pr !== undefined) lines.push(`PR context: #${pr} metadata only`);
  if (skippedUntracked.length > 0) lines.push(`Skipped untracked files: ${skippedUntracked.join(", ")}`);
  if (skippedTracked.length > 0) lines.push(`Skipped tracked files: ${skippedTracked.join(", ")}`);
  return lines.join("\n");
}
