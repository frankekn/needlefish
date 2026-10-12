import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyFiles } from "./classify.js";
import { normalizePrMeta } from "./normalize.js";
import { runText, type RunOptions } from "./process.js";
import type { Bundle, ChangedFile, PrMeta, UntrackedSkippedFile } from "./schema.js";

// Exported so --dry-run can report whether a real AGENTS.md was collected
// versus this fallback sentinel.
export const NO_AGENTS =
  "(no AGENTS.md in this repo — apply only generic senior-engineer review judgment; do NOT substitute any global/CLI-injected instructions file as policy)";

export function git(
  args: readonly string[],
  cwd: string,
  opts?: Pick<RunOptions, "preserveOutput">
): string {
  return runText("git", args, { cwd, ...opts });
}

export function ghText(args: readonly string[], cwd?: string, input?: string): string {
  return runText("gh", args, { cwd, input });
}

// Pathname output is NUL-delimited and never trimmed: newline-delimited
// listings C-quote non-ASCII and control bytes, and trimming would mangle
// names with leading or trailing whitespace. Either way the "path" is no
// longer a path, the file drops out of classification, and a source change
// can ride the docs-only fast path. Rename detection is off for the same
// reason: a rename lists only its destination, so moving a workflow, policy,
// or source file into a docs path would hide the removal of the original.
export function gitPathList(args: readonly string[], cwd: string): string[] {
  const output = runText("git", args, { cwd, preserveOutput: true });
  return output.split("\0").filter(Boolean);
}

// .gitattributes is repository-controlled, so it must not decide what the
// reviewer sees: one `* -diff` (or `* binary`) line in a PR turns every hunk
// into a "Binary files differ" stub and hides all content from review. These
// flags make git emit text content regardless of the diff/binary attributes,
// textconv filters, and external diff drivers. Every patch producer used for
// review must use reviewDiffArgs.
export const ATTRIBUTE_NEUTRAL_DIFF_FLAGS = ["--text", "--no-textconv", "--no-ext-diff"] as const;

/** `git diff` argv for a review patch: attribute-neutral, minus excluded paths. */
export function reviewDiffArgs(
  extraArgs: readonly string[],
  rangeArgs: readonly string[],
  excludedPaths: readonly string[] = []
): string[] {
  const args = ["diff", ...extraArgs, ...ATTRIBUTE_NEUTRAL_DIFF_FLAGS, ...rangeArgs];
  if (excludedPaths.length === 0) return args;
  // `literal` magic: a binary file named `a[b].png` must exclude only itself,
  // not every path matching the glob (e.g. `ab.png`), or those changes vanish
  // from the patch, the name list, and the stat without a trace (#218).
  return [...args, "--", ".", ...excludedPaths.map((filePath) => `:(exclude,literal)${filePath}`)];
}

// A blob bigger than this is binary for review purposes without reading it:
// it is not reviewable text, and runText's 64MB stdout cap would throw on it.
export const BLOB_SNIFF_MAX_BYTES = 16 * 1024 * 1024;

// A --batch-check line for a present object is "<oid> <type> <size>" (no
// echo); for a missing input it is "<input> missing". Inputs may contain
// spaces, so present records are matched from the end; inputs with newlines
// are filtered out by the caller and cannot appear here.
function blobRecord(line: string): { readonly type: string; readonly size: number } | null {
  const present = /(?:^| )([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
  return present ? { type: present[2]!, size: Number(present[3]) } : null;
}

/**
 * Changed paths whose content is binary, judged by content (NUL bytes), not
 * by .gitattributes. Each path is sniffed at headRef and, when absent there
 * (deleted), at baseRef. Paths containing newlines break the positional
 * batch-check parsing and are reported as text: shown rather than hidden.
 */
export function contentBinaryPaths(
  cwd: string,
  headRef: string,
  baseRef: string,
  paths: readonly string[]
): string[] {
  const queried = paths.filter((filePath) => !filePath.includes("\n"));
  if (queried.length === 0) return [];
  const refs = queried.flatMap((filePath) => [`${headRef}:${filePath}`, `${baseRef}:${filePath}`]);
  const check = runText("git", ["cat-file", "--batch-check"], {
    cwd,
    input: `${refs.join("\n")}\n`,
    preserveOutput: true,
  });
  const records = check.split("\n");
  const binary: string[] = [];
  for (let i = 0; i < queried.length; i += 1) {
    const head = blobRecord(records[2 * i] ?? "");
    const base = blobRecord(records[2 * i + 1] ?? "");
    const record = head ?? base;
    if (!record || record.type !== "blob") continue;
    const spec = `${head ? headRef : baseRef}:${queried[i]}`;
    if (record.size > BLOB_SNIFF_MAX_BYTES || git(["cat-file", "blob", spec], cwd, { preserveOutput: true }).includes("\u0000")) {
      binary.push(queried[i]!);
    }
  }
  return binary;
}

export function binarySkippedSuffix(binarySkipped: readonly string[]): string {
  return binarySkipped.length > 0
    ? ` Binary files skipped from the patch: ${binarySkipped.join(", ")}.`
    : "";
}

export function changedFiles(cwd: string, baseSha: string, headSha = "HEAD"): ChangedFile[] {
  return changedFilesFromPaths(
    gitPathList(["diff", "--name-only", "-z", "--no-renames", baseSha, headSha], cwd)
  );
}

export function changedFilesFromPaths(paths: readonly string[]): ChangedFile[] {
  return classifyFiles(paths.filter(Boolean));
}

export function readAgents(cwd: string): string {
  const agentsPath = path.join(cwd, "AGENTS.md");
  return existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : NO_AGENTS;
}

export function readAgentsAt(cwd: string, ref: string): string {
  try {
    return git(["show", `${ref}:AGENTS.md`], cwd);
  } catch (err) {
    if (err instanceof Error) return NO_AGENTS;
    throw err;
  }
}

export interface BundleInput {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly patch: string;
  readonly patchStat: string;
  readonly changedFiles: ChangedFile[];
  readonly reviewTarget?: string;
  readonly untrackedSkipped?: readonly UntrackedSkippedFile[];
  readonly binarySkipped?: readonly string[];
  readonly prMeta: PrMeta | null;
  readonly deep: boolean;
  readonly focus: string | null;
  readonly agentsMd?: string;
}

export function makeBundle(input: BundleInput): Bundle {
  return {
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    headSha: input.headSha,
    patch: input.patch,
    patchStat: input.patchStat,
    changedFiles: input.changedFiles,
    ...(input.reviewTarget ? { reviewTarget: input.reviewTarget } : {}),
    ...(input.untrackedSkipped?.length ? { untrackedSkipped: input.untrackedSkipped } : {}),
    ...(input.binarySkipped?.length ? { binarySkipped: input.binarySkipped } : {}),
    agentsMd: input.agentsMd ?? readAgents(input.repoPath),
    prMeta: input.prMeta,
    deep: input.deep,
    focus: input.focus,
  };
}

export interface PrRefInfo {
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly prMeta: PrMeta;
}

export function fetchPrRefInfo(cwd: string, prNumber: number): PrRefInfo {
  const raw = ghText(
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,title,body,comments,reviews,statusCheckRollup,baseRefOid,headRefOid,baseRefName,headRefName",
    ],
    cwd
  );
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`PR #${prNumber}: gh response was not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const baseSha = typeof record.baseRefOid === "string" ? record.baseRefOid : "";
  const headSha = typeof record.headRefOid === "string" ? record.headRefOid : "";
  const baseRefName = typeof record.baseRefName === "string" ? record.baseRefName : "";
  const headRefName = typeof record.headRefName === "string" ? record.headRefName : "";
  if (!baseSha || !headSha || !baseRefName || !headRefName) {
    throw new Error(`PR #${prNumber}: could not resolve base/head refs via gh`);
  }
  return {
    baseSha,
    headSha,
    baseRefName,
    headRefName,
    prMeta: normalizePrMeta(parsed, prNumber),
  };
}

function hasCommit(cwd: string, sha: string): boolean {
  try {
    runText("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function hasMergeBase(cwd: string, baseSha: string, headSha: string): boolean {
  try {
    runText("git", ["merge-base", baseSha, headSha], { cwd });
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function tryFetch(cwd: string, args: readonly string[]): boolean {
  try {
    runText("git", args, { cwd, timeoutMs: 120000 });
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function listRemotes(cwd: string): string[] {
  const out = git(["remote"], cwd);
  const preferred = ["upstream", "origin"];
  const all = out.split("\n").filter(Boolean);
  return [...preferred.filter((name) => all.includes(name)), ...all.filter((name) => !preferred.includes(name))];
}

function isShallow(cwd: string): boolean {
  try {
    return git(["rev-parse", "--is-shallow-repository"], cwd) === "true";
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function deepenShallowPrRefs(cwd: string, remotes: readonly string[], refs: readonly string[]): void {
  if (!isShallow(cwd)) return;
  for (const remote of remotes) {
    for (const ref of refs) {
      if (!isShallow(cwd)) return;
      tryFetch(cwd, ["fetch", "--quiet", "--unshallow", remote, ref]);
    }
  }
}

export function ensurePrCommits(cwd: string, pr: PrRefInfo): void {
  const ready = () =>
    hasCommit(cwd, pr.baseSha) &&
    hasCommit(cwd, pr.headSha) &&
    hasMergeBase(cwd, pr.baseSha, pr.headSha);
  const remotes = listRemotes(cwd);
  const pullRef = `pull/${pr.prMeta.number}/head`;
  const prRefs = [pullRef, pr.baseRefName, pr.headRefName];
  const readyForSandbox = () => ready() && !isShallow(cwd);

  if (ready()) {
    deepenShallowPrRefs(cwd, remotes, prRefs);
    if (readyForSandbox()) return;
  }

  for (const remote of remotes) {
    if (readyForSandbox()) return;
    tryFetch(cwd, ["fetch", "--quiet", remote, pullRef]);
  }

  for (const remote of remotes) {
    for (const ref of [pr.baseRefName, pr.headRefName]) {
      if (readyForSandbox()) return;
      tryFetch(cwd, ["fetch", "--quiet", remote, ref]);
    }
  }

  for (const sha of [pr.baseSha, pr.headSha]) {
    if (hasCommit(cwd, sha)) continue;
    for (const remote of remotes) {
      if (tryFetch(cwd, ["fetch", "--quiet", remote, sha])) break;
    }
  }

  deepenShallowPrRefs(cwd, remotes, prRefs);

  const missingBase = !hasCommit(cwd, pr.baseSha);
  const missingHead = !hasCommit(cwd, pr.headSha);
  const missingMergeBase = !missingBase && !missingHead && !hasMergeBase(cwd, pr.baseSha, pr.headSha);
  const shallow = isShallow(cwd);
  if (!missingBase && !missingHead && !missingMergeBase && !shallow) return;

  throw new Error(
    `PR #${pr.prMeta.number}: missing ${[
      missingBase ? "base" : "",
      missingHead ? "head" : "",
      missingMergeBase ? "merge-base" : "",
      shallow ? "unshallowed-history" : "",
    ]
      .filter(Boolean)
      .join("/")} commit locally; try git fetch`
  );
}

export function prDiffFromShas(cwd: string, baseSha: string, headSha: string) {
  const mergeBase = git(["merge-base", baseSha, headSha], cwd);
  const files = changedFiles(cwd, mergeBase, headSha);
  const binarySkipped = contentBinaryPaths(cwd, headSha, mergeBase, files.map((file) => file.path));
  const patch = git(reviewDiffArgs([], [mergeBase, headSha], binarySkipped), cwd, {
    preserveOutput: true,
  });
  if (!patch.trim()) {
    throw new Error(
      `No diff between ${mergeBase} and ${headSha}. Nothing to review.${binarySkippedSuffix(binarySkipped)}`
    );
  }
  return {
    baseSha: mergeBase,
    headSha,
    patch,
    patchStat: git(reviewDiffArgs(["--stat"], [mergeBase, headSha], binarySkipped), cwd, {
      preserveOutput: true,
    }),
    changedFiles: files,
    binarySkipped,
  };
}
