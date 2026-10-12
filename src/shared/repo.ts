import path from "node:path";
import { classifyFiles } from "./classify.js";
import { normalizePrMeta } from "./normalize.js";
import { runText, type RunOptions } from "./process.js";
import type { Bundle, ChangedFile, PrMeta, UntrackedSkippedFile } from "./schema.js";

// Exported so --dry-run can report whether a real AGENTS.md was collected
// versus this fallback sentinel.
export const NO_AGENTS =
  "(no AGENTS.md in this repo — apply only generic senior-engineer review judgment; do NOT substitute any global/CLI-injected instructions file as policy)";

// An inherited GIT_LITERAL_PATHSPECS turns `:(exclude,literal)` into a plain
// file name, and GIT_ICASE_PATHSPECS widens it: either way the binary
// excludes stop matching what they name.
function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_(LITERAL|GLOB|NOGLOB|ICASE)_PATHSPECS$/.test(key))
  );
}

export function git(
  args: readonly string[],
  cwd: string,
  opts?: Pick<RunOptions, "preserveOutput">
): string {
  return runText("git", args, { cwd, env: gitEnv(), ...opts });
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
  const output = runText("git", args, { cwd, env: gitEnv(), preserveOutput: true });
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
  // `top` magic: paths are root-relative, whatever the cwd.
  return [...args, "--", ":/", ...excludedPaths.map((filePath) => `:(top,exclude,literal)${filePath}`)];
}

/**
 * Pathspecs matching exactly these files. A plain path also matches
 * everything beneath it, so a file that replaced a directory (or the reverse)
 * would drag the other side's directory contents along.
 */
export function exactPathspecs(paths: readonly string[]): string[] {
  return paths.flatMap((filePath) => [`:(top,literal)${filePath}`, `:(top,exclude,literal)${filePath}/`]);
}

// macOS caps argv plus the environment at 1 MiB; pathspecs stay well under.
const PATHSPEC_ARGV_BUDGET = 256 * 1024;
const pathspecBytes = (filePath: string): number => 2 * Buffer.byteLength(filePath) + 32;

const ancestorDirs = (filePath: string): string[] => {
  const dirs: string[] = [];
  for (let slash = filePath.indexOf("/"); slash !== -1; slash = filePath.indexOf("/", slash + 1)) {
    dirs.push(filePath.slice(0, slash));
  }
  return dirs;
};

/**
 * `git <args> -- <exactly these paths>`, split into calls that fit in argv.
 * A path and one beneath it (`old.ts` deleted, `old.ts/new.ts` added) go to
 * separate calls: the exclude half of `old.ts` would also drop `old.ts/new.ts`.
 */
export function gitExactPaths(cwd: string, args: readonly string[], paths: readonly string[]): string {
  let output = "";
  let batch: string[] = [];
  let bytes = 0;
  let batchPaths = new Set<string>();
  let batchDirs = new Set<string>();
  const flush = () => {
    if (batch.length > 0) output += git([...args, "--", ...exactPathspecs(batch)], cwd, { preserveOutput: true });
    batch = [];
    bytes = 0;
    batchPaths = new Set();
    batchDirs = new Set();
  };
  for (const filePath of paths) {
    const dirs = ancestorDirs(filePath);
    if (
      bytes + pathspecBytes(filePath) > PATHSPEC_ARGV_BUDGET ||
      batchDirs.has(filePath) ||
      dirs.some((dir) => batchPaths.has(dir))
    ) {
      flush();
    }
    batch.push(filePath);
    bytes += pathspecBytes(filePath);
    batchPaths.add(filePath);
    for (const dir of dirs) batchDirs.add(dir);
  }
  flush();
  return output;
}

/**
 * A review patch (or stat) minus excluded paths. An exclude pathspec also
 * hides everything beneath the path, so when a binary file was swapped for a
 * directory, the changed paths under it are diffed in a second pass instead
 * of vanishing from review.
 */
export function reviewDiff(
  cwd: string,
  extraArgs: readonly string[],
  rangeArgs: readonly string[],
  excludedPaths: readonly string[],
  changedPaths: readonly string[]
): string {
  const excluded = new Set(excludedPaths);
  const included = changedPaths.filter((filePath) => !excluded.has(filePath));
  const excludedAncestor = (filePath: string): string | undefined =>
    ancestorDirs(filePath).find((dir) => excluded.has(dir));
  const shadowed = included.filter((filePath) => excludedAncestor(filePath) !== undefined);
  const shadowing = [...new Set(shadowed.map((filePath) => excludedAncestor(filePath)!))];
  const stubs =
    shadowing.length > 0 && !extraArgs.includes("--stat") ? binaryDeletionStubs(cwd, rangeArgs, shadowing) : "";
  // Too many exclusions for one argv: name the included files instead.
  if (excludedPaths.reduce((sum, filePath) => sum + pathspecBytes(filePath), 0) > PATHSPEC_ARGV_BUDGET) {
    return stubs + gitExactPaths(cwd, reviewDiffArgs(extraArgs, rangeArgs), included);
  }
  return (
    stubs +
    git(reviewDiffArgs(extraArgs, rangeArgs, excludedPaths), cwd, { preserveOutput: true }) +
    gitExactPaths(cwd, reviewDiffArgs(extraArgs, rangeArgs), shadowed)
  );
}

// `git apply` (the WORKING sandbox) cannot put a directory where a file still
// is, so a binary swapped for a directory keeps a content-free deletion record:
// git's header with the full preimage id, then the binary marker apply expects.
function binaryDeletionStubs(cwd: string, rangeArgs: readonly string[], binaryPaths: readonly string[]): string {
  const headers = gitExactPaths(
    cwd,
    [
      "diff",
      "--full-index",
      "--irreversible-delete",
      // A binary moved under its own path is a rename otherwise, not a D.
      "--no-renames",
      "--diff-filter=D",
      ...ATTRIBUTE_NEUTRAL_DIFF_FLAGS,
      ...rangeArgs,
    ],
    binaryPaths
  );
  return headers.replace(/^(index [0-9a-f]+\.\.0+)$/gm, "$1\nBinary files differ");
}

// A blob bigger than this is binary for review purposes without reading it:
// it is not reviewable text, and runText's 64MB stdout cap would throw on it.
export const BLOB_SNIFF_MAX_BYTES = 16 * 1024 * 1024;

type BlobRecord = { readonly type: string; readonly size: number };

// A --batch-check line for a present object is "<oid> <type> <size>" (no
// echo); for a missing input it is "<input> missing". Inputs may contain
// spaces, so present records are matched from the end; inputs with a newline
// or CR never reach --batch-check (see blobRecordOf).
function blobRecord(line: string): BlobRecord | null {
  const present = /(?:^| )([0-9a-f]{40,64}) (\w+) (\d+)$/.exec(line);
  return present ? { type: present[2]!, size: Number(present[3]) } : null;
}

// --batch-check is line-based (and strips a trailing CR), so a path
// containing a newline or CR is looked up on its own; a missing object is
// null, as in blobRecord.
const lineUnsafe = (filePath: string): boolean => /[\r\n]/.test(filePath);

function blobRecordOf(cwd: string, spec: string): BlobRecord | null {
  try {
    return { type: git(["cat-file", "-t", spec], cwd), size: Number(git(["cat-file", "-s", spec], cwd)) };
  } catch {
    return null;
  }
}

/**
 * Changed paths whose content is binary, judged by content (NUL bytes), not
 * by .gitattributes. A path is binary when its blob at either headRef or
 * baseRef is: --text would otherwise inline the raw side's bytes.
 */
export function contentBinaryPaths(
  cwd: string,
  headRef: string,
  baseRef: string,
  paths: readonly string[]
): string[] {
  const records = new Map<string, readonly [BlobRecord | null, BlobRecord | null]>();
  const batched = paths.filter((filePath) => !lineUnsafe(filePath));
  if (batched.length > 0) {
    const refs = batched.flatMap((filePath) => [`${headRef}:${filePath}`, `${baseRef}:${filePath}`]);
    const lines = runText("git", ["cat-file", "--batch-check"], {
      cwd,
      input: `${refs.join("\n")}\n`,
      preserveOutput: true,
    }).split("\n");
    batched.forEach((filePath, i) =>
      records.set(filePath, [blobRecord(lines[2 * i] ?? ""), blobRecord(lines[2 * i + 1] ?? "")])
    );
  }
  for (const filePath of paths) {
    if (lineUnsafe(filePath)) {
      records.set(filePath, [
        blobRecordOf(cwd, `${headRef}:${filePath}`),
        blobRecordOf(cwd, `${baseRef}:${filePath}`),
      ]);
    }
  }
  const isBinaryBlob = (record: BlobRecord | null, ref: string, filePath: string): boolean =>
    record !== null &&
    record.type === "blob" &&
    (record.size > BLOB_SNIFF_MAX_BYTES ||
      git(["cat-file", "blob", `${ref}:${filePath}`], cwd, { preserveOutput: true }).includes("\u0000"));
  return paths.filter((filePath) => {
    const [head, base] = records.get(filePath)!;
    return isBinaryBlob(head, headRef, filePath) || (baseRef !== headRef && isBinaryBlob(base, baseRef, filePath));
  });
}

export function changedFiles(cwd: string, baseSha: string, headSha = "HEAD"): ChangedFile[] {
  return changedFilesFromPaths(
    gitPathList(["diff", "--name-only", "-z", "--no-renames", baseSha, headSha], cwd)
  );
}

export function changedFilesFromPaths(paths: readonly string[]): ChangedFile[] {
  return classifyFiles(paths.filter(Boolean));
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

// One path inside <ref>'s tree, from `git ls-tree <ref> -- <path>`; empty
// output means the commit has no such path. A trailing-slash path lists the
// directory's contents instead, so the entry's path must match exactly.
// Never touches the working tree.
function treeEntry(cwd: string, ref: string, filePath: string): TreeEntry | null {
  // -z: raw, unquoted path (non-ASCII or quote characters are otherwise
  // C-quoted). --literal-pathspecs: a target like "a[b].md" is not a glob.
  const line = git(["--literal-pathspecs", "ls-tree", "-z", ref, "--", filePath], cwd, { preserveOutput: true }).split("\0", 1)[0];
  if (!line) return null;
  const tab = line.indexOf("\t");
  if (tab < 0 || line.slice(tab + 1) !== filePath) return null;
  const [mode, type, sha] = line.slice(0, tab).split(" ");
  if (!mode || !type || !sha) return null;
  return { mode, type, sha };
}

function isRegularBlob(entry: TreeEntry | null): entry is TreeEntry {
  return entry !== null && entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
}

// The only policy read path (issue #211): everything comes from git objects
// at <ref>, so a symlinked, tree-shaped, or otherwise special AGENTS.md can
// never disclose a runner-readable file or hang on a special file. A
// committed symlink is a blob holding its link text; it resolves exactly one
// hop when that text is a repo-relative path (never absolute, never escaping
// the root after normalization) to a regular blob in the same tree — no
// chains, no trees, no submodules. Anything else yields NO_AGENTS rather
// than feeding the link's target path to the model as fake policy.
export function readAgentsAt(cwd: string, ref: string): string {
  try {
    const entry = treeEntry(cwd, ref, "AGENTS.md");
    if (!entry) return NO_AGENTS;
    if (entry.mode !== "120000") {
      return isRegularBlob(entry) ? git(["cat-file", "blob", entry.sha], cwd) : NO_AGENTS;
    }
    // Raw link text: trimming would turn " policy.md " into another file's name.
    const resolved = path.posix.normalize(git(["cat-file", "blob", entry.sha], cwd, { preserveOutput: true }));
    if (!resolved || resolved === "." || resolved.startsWith("/") || resolved === ".." || resolved.startsWith("../")) {
      return NO_AGENTS;
    }
    const target = treeEntry(cwd, ref, resolved);
    return isRegularBlob(target) ? git(["cat-file", "blob", target.sha], cwd) : NO_AGENTS;
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
  readonly agentsMd: string;
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
    agentsMd: input.agentsMd,
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
  const paths = files.map((file) => file.path);
  const binarySkipped = contentBinaryPaths(cwd, headSha, mergeBase, paths);
  const patch = reviewDiff(cwd, [], [mergeBase, headSha], binarySkipped, paths);
  // A binary-only change has an empty patch but is still a change: review()
  // reports its files as coverage gaps.
  if (!patch.trim() && binarySkipped.length === 0) {
    throw new Error(`No diff between ${mergeBase} and ${headSha}. Nothing to review.`);
  }
  return {
    baseSha: mergeBase,
    headSha,
    patch,
    patchStat: reviewDiff(cwd, ["--stat"], [mergeBase, headSha], binarySkipped, paths),
    changedFiles: files,
    binarySkipped,
  };
}
