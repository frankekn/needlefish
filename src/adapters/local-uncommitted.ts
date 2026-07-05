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

interface NumstatRow {
  readonly additions: string;
  readonly deletions: string;
  readonly path: string;
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

function parseNumstatRow(row: string): NumstatRow | null {
  const firstTab = row.indexOf("\t");
  if (firstTab === -1) return null;
  const secondTab = row.indexOf("\t", firstTab + 1);
  if (secondTab === -1) return null;
  return {
    additions: row.slice(0, firstTab),
    deletions: row.slice(firstTab + 1, secondTab),
    path: row.slice(secondTab + 1),
  };
}

export function parseTrackedBinaryPathsFromNumstat(numstat: string): string[] {
  const fields = numstat ? numstat.split("\0") : [];
  const paths: string[] = [];
  const seen = new Set<string>();
  const addPath = (filePath: string): void => {
    if (!filePath || seen.has(filePath)) return;
    seen.add(filePath);
    paths.push(filePath);
  };

  let index = 0;
  while (index < fields.length) {
    const row = parseNumstatRow(fields[index] ?? "");
    index += 1;
    if (!row) continue;

    const isBinaryRow = row.additions === "-" && row.deletions === "-";
    if (row.path === "") {
      const oldPath = fields[index] ?? "";
      const newPath = fields[index + 1] ?? "";
      index += 2;
      if (isBinaryRow) {
        addPath(oldPath);
        addPath(newPath);
      }
      continue;
    }

    if (isBinaryRow) addPath(row.path);
  }

  return paths;
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
