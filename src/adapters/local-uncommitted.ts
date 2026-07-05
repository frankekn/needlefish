import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export const EMPTY_BASE_SHA = "EMPTY";
export const WORKING_HEAD_SHA = "WORKING";

const MAX_UNTRACKED_FILE_BYTES = 200 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 1024 * 1024;

export interface UntrackedPatch {
  readonly patch: string;
  readonly patchStat: string;
  readonly paths: readonly string[];
  readonly skipped: readonly string[];
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

function diffLines(text: string): { readonly lines: readonly string[]; readonly hasFinalNewline: boolean } {
  if (text === "") return { lines: [], hasFinalNewline: true };
  const hasFinalNewline = text.endsWith("\n");
  const lines = text.split("\n");
  return { lines: hasFinalNewline ? lines.slice(0, -1) : lines, hasFinalNewline };
}

function newFileDiff(filePath: string, content: Buffer): { readonly patch: string; readonly insertions: number } {
  const text = content.toString("utf8");
  const { lines, hasFinalNewline } = diffLines(text);
  const hunk = [`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)];
  if (!hasFinalNewline) hunk.push("\\ No newline at end of file");
  return {
    patch: [
      `diff --git a/${filePath} b/${filePath}`,
      "new file mode 100644",
      "index 0000000..0000000",
      "--- /dev/null",
      `+++ b/${filePath}`,
      ...hunk,
    ].join("\n") + "\n",
    insertions: lines.length,
  };
}

function statLine(filePath: string, insertions: number): string {
  const pluses = "+".repeat(Math.min(insertions, 40));
  return ` ${filePath} | ${insertions} ${pluses}`;
}

export function buildUntrackedPatch(cwd: string, files: readonly string[]): UntrackedPatch {
  const patches: string[] = [];
  const statLines: string[] = [];
  const paths: string[] = [];
  const skipped: string[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const absolutePath = path.join(cwd, file);
    const stat = statSync(absolutePath);
    if (!stat.isFile()) {
      skipped.push(`${file} (not a regular file)`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
      skipped.push(`${file} (over 200KB)`);
      continue;
    }
    const content = readFileSync(absolutePath);
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
      continue;
    }
    const diff = newFileDiff(file, content);
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
  };
}

export function joinSections(parts: readonly string[]): string {
  return parts.filter((part) => part.trim()).join("\n");
}

export function formatUncommittedReviewTarget(pr: number | undefined, skipped: readonly string[]): string {
  const lines = ["Review target: uncommitted changes"];
  if (pr !== undefined) lines.push(`PR context: #${pr} metadata only`);
  if (skipped.length > 0) lines.push(`Skipped untracked files: ${skipped.join(", ")}`);
  return lines.join("\n");
}
