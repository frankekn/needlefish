import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, type Stats } from "node:fs";
import path from "node:path";
import {
  ATTRIBUTE_NEUTRAL_DIFF_FLAGS,
  BLOB_SNIFF_MAX_BYTES,
  contentBinaryPaths,
  exactPathspecs,
  git,
  gitExactPaths,
  gitPathList,
  gitPrefix,
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
 * judged by content, not by .gitattributes: the HEAD blob, and the work-tree
 * side as git compares it (after clean filters and working-tree-encoding),
 * read from the attribute-neutral patch, or the staged blob for a
 * skip-worktree or assume-unchanged entry, whatever is on disk.
 * Input order is preserved so skip lists stay stable.
 */
export function workingBinaryPaths(
  cwd: string,
  headRef: string,
  paths: readonly string[]
): string[] {
  const flagged = new Set(contentBinaryPaths(cwd, headRef, headRef, paths));
  // Deleted as git sees it: lstat would follow a symlinked parent directory
  // to an unrelated file of the same name.
  const deleted = new Set(gitPathList(["diff", "--name-only", "-z", "--no-renames", "--diff-filter=D", headRef], cwd));
  const candidates = paths.filter((filePath) => !flagged.has(filePath) && !deleted.has(filePath));
  // Skip-worktree ("S") or assume-unchanged (lower case) entries: git diff
  // takes the new side from the staged blob, `:path`, not from the disk.
  const indexSide = new Set(
    gitExactPaths(cwd, ["ls-files", "-v", "-z", "--full-name"], candidates)
      .split("\0")
      .filter((entry) => /^(S|[a-z]) /.test(entry))
      .map((entry) => entry.slice(2))
  );
  // Explicit stage: `:0:app.ts` alone would read stage 0 of `app.ts`.
  for (const filePath of contentBinaryPaths(cwd, ":0", ":0", [...indexSide])) flagged.add(filePath);
  const sniff: string[] = [];
  for (const filePath of candidates) {
    if (indexSide.has(filePath)) continue;
    let stat: Stats | undefined;
    try {
      stat = lstatSync(path.join(cwd, filePath));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
    // Not a regular file: a symlink, whose new side is a short target.
    if (stat?.isFile()) sniff.push(filePath);
  }
  // One capped diff per path against the empty tree: the output is only the
  // new side as git compares it, so deleted lines cannot fill the cap first.
  // Each content byte costs at most two output bytes (a "+" per line), plus
  // headers, so the cap covers the same content prefix as contentBinaryPaths.
  const emptyTree = sniff.length > 0 ? git(["hash-object", "-t", "tree", "/dev/null"], cwd) : "";
  for (const filePath of sniff) {
    const patch = gitPrefix(
      ["diff", ...ATTRIBUTE_NEUTRAL_DIFF_FLAGS, emptyTree, "--", ...exactPathspecs([filePath])],
      cwd,
      2 * BLOB_SNIFF_MAX_BYTES + 1024 * 1024
    );
    if (patch.includes(0)) flagged.add(filePath);
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
  // ENOTDIR: a parent directory was replaced by a file, so the path is gone.
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ENOTDIR");
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
