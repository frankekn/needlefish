import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  review,
  reviewPlan,
  type ReviewProgressEvent,
  type ReviewProgressObserver,
} from "../core/review.js";
import { renderMarkdown } from "../shared/render.js";
import {
  changedFiles,
  changedFilesFromPaths,
  ensurePrCommits,
  fetchPrRefInfo,
  ghText,
  git,
  gitPathList,
  makeBundle,
  NO_AGENTS,
  prDiffFromShas,
  readAgentsAt,
  type PrRefInfo,
} from "../shared/repo.js";
import { normalizePrMeta } from "../shared/normalize.js";
import {
  serializeReviewResult,
  type Bundle,
  type ChangedFile,
  type ReviewResult,
  type UntrackedSkippedFile,
} from "../shared/schema.js";
import type { RunnerOptions } from "../shared/runner.js";
import {
  buildUntrackedPatch,
  EMPTY_BASE_SHA,
  formatUncommittedReviewTarget,
  joinSections,
  parseTrackedBinaryPathsFromNumstat,
  WORKING_HEAD_SHA,
} from "./local-uncommitted.js";

function detectBase(cwd: string, override?: string): string {
  if (override) return override;
  try {
    const head = git(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd
    );
    if (head) return head;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
  }
  return "main";
}

export const BASE_FIX = "Pass --base <ref> to name the branch to compare against.";

export class BaseRefError extends Error {
  constructor(
    readonly baseRef: string,
    readonly reason: string,
    options?: ErrorOptions,
  ) {
    super(`Base ref '${baseRef}' cannot be used (${reason}). ${BASE_FIX}`, options);
    this.name = "BaseRefError";
  }
}

export interface ReviewBase {
  readonly baseRef: string;
  readonly baseSha: string;
}

/** The branch-mode review base: `--base`, else origin/HEAD, else `main`, resolved to its merge base with HEAD. */
export function resolveReviewBase(cwd: string, override?: string): ReviewBase {
  const baseRef = detectBase(cwd, override);
  try {
    return { baseRef, baseSha: git(["merge-base", baseRef, "HEAD"], cwd) };
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    throw new BaseRefError(baseRef, err.message, { cause: err });
  }
}

export type GitRepoState =
  | { readonly kind: "repo" }
  | { readonly kind: "not-a-repo" }
  /** git could not answer: the path or git itself is missing, or git refused the repository. */
  | { readonly kind: "unavailable"; readonly reason: string; readonly fix?: string };

const REPO_PATH_FIX = "Check the --repo path.";

export function gitRepoState(cwd: string): GitRepoState {
  // The messages matched below are gettext-translated; C keeps them English.
  const env = { ...process.env, LC_ALL: "C" };
  delete env.LANGUAGE;
  const res = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8", env });
  if (res.error) {
    // A missing cwd and a missing git both surface as ENOENT on the spawn.
    const code = "code" in res.error ? res.error.code : undefined;
    if (code === "ENOENT" && !existsSync(cwd)) {
      return { kind: "unavailable", reason: `${cwd} does not exist`, fix: REPO_PATH_FIX };
    }
    if (code === "ENOENT") {
      return { kind: "unavailable", reason: "git is not installed or not on PATH", fix: "Install git." };
    }
    return { kind: "unavailable", reason: `${cwd} cannot be used (${res.error.message})`, fix: REPO_PATH_FIX };
  }
  if (res.status === 0) return res.stdout.trim() === "true" ? { kind: "repo" } : { kind: "not-a-repo" };
  const reason = res.stderr.trim().split(/\r?\n/)[0] ?? "";
  if (/not a git repository/i.test(reason)) return { kind: "not-a-repo" };
  return {
    kind: "unavailable",
    reason: reason || `git rev-parse exited ${res.status}`,
    ...(/dubious ownership/i.test(reason)
      ? { fix: `Run \`git config --global --add safe.directory ${cwd}\`.` }
      : {}),
  };
}

function ensureGitRepo(cwd: string): void {
  const state = gitRepoState(cwd);
  if (state.kind === "repo") return;
  if (state.kind === "not-a-repo") {
    throw new Error("This folder is not a git repository yet. Run `git init` inside your project folder first.");
  }
  throw new Error(state.fix === undefined ? state.reason : `${state.reason}. ${state.fix}`);
}

export function hasHeadCommit(cwd: string): boolean {
  try {
    git(["cat-file", "-e", "HEAD^{commit}"], cwd);
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function trackedDiffArgs(extraArgs: readonly string[], excludedPaths: readonly string[]): string[] {
  const args = ["diff", ...extraArgs, "HEAD"];
  if (excludedPaths.length === 0) return args;
  return [...args, "--", ".", ...excludedPaths.map((filePath) => `:(exclude)${filePath}`)];
}

function fetchPrMeta(cwd: string, prNumber: number) {
  try {
    const raw = ghText(
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,title,body,comments,reviews,statusCheckRollup",
      ],
      cwd
    );
    return normalizePrMeta(JSON.parse(raw), prNumber);
  } catch (err) {
    if (err instanceof Error) {
      throw new Error(
        `--pr ${prNumber} requested, but PR metadata could not be fetched: ${err.message}. Check gh auth or remove --pr for local-only review.`,
        { cause: err }
      );
    }
    throw err;
  }
}

function cacheSlug(cwd: string): string {
  try {
    const url = git(["config", "--get", "remote.origin.url"], cwd);
    const match = url.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (match) return `${match[1]}-${match[2]}`;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
  }
  return path.basename(cwd);
}

function writeCache(cwd: string, opts: LocalOptions, result: ReviewResult): void {
  const cache = opts.cacheDir ?? path.join(os.homedir(), ".cache", "needlefish", cacheSlug(cwd));
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "last-review.json"), serializeReviewResult(result));
}

function branchDiffBundle(cwd: string, opts: LocalOptions): Bundle {
  if (!hasHeadCommit(cwd)) {
    throw new Error("No commits yet. Run without --branch to review uncommitted files.");
  }
  const dirty = git(["status", "--porcelain"], cwd);
  if (dirty.trim()) {
    process.stderr.write(
      "needlefish: warning: uncommitted changes are not included; review is merge-base..HEAD only.\n"
    );
  }
  const { baseRef, baseSha } = resolveReviewBase(cwd, opts.base);
  const headSha = git(["rev-parse", "HEAD"], cwd);
  const patch = git(["diff", baseSha, "HEAD"], cwd, { preserveOutput: true });
  if (!patch.trim()) {
    throw new Error(
      `No diff between ${baseSha} and HEAD (${baseRef}). Nothing to review. Commit changes on this branch first, or pass --base <ref> to compare against another branch.`
    );
  }
  return makeBundle({
    repoPath: cwd,
    baseSha,
    headSha,
    patch,
    patchStat: git(["diff", "--stat", baseSha, "HEAD"], cwd, { preserveOutput: true }),
    changedFiles: changedFiles(cwd, baseSha),
    ...(opts.pr
      ? {
          reviewTarget: `Review target: local ${baseSha}..${headSha}\nPR context: #${opts.pr} metadata only`,
          prMeta: fetchPrMeta(cwd, opts.pr),
        }
      : { prMeta: null }),
    deep: Boolean(opts.deep),
    focus: opts.focus ?? null,
  });
}

function uncommittedDiffBundle(cwd: string, opts: LocalOptions, headExists: boolean): Bundle {
  const baseSha = headExists ? git(["rev-parse", "HEAD"], cwd) : EMPTY_BASE_SHA;
  const trackedBinaryPaths = headExists
    ? parseTrackedBinaryPathsFromNumstat(git(["diff", "--numstat", "-z", "HEAD"], cwd))
    : [];
  const trackedPatch = headExists
    ? git(trackedDiffArgs([], trackedBinaryPaths), cwd, { preserveOutput: true })
    : "";
  const trackedPatchStat = headExists
    ? git(trackedDiffArgs(["--stat"], trackedBinaryPaths), cwd, { preserveOutput: true })
    : "";
  // Rename detection off for the name list only: a `git mv` into a docs path
  // must keep its removed source path, or classification sees docs alone and
  // the fast path skips the review. The patch above keeps its rename headers.
  const trackedPaths = headExists
    ? gitPathList(trackedDiffArgs(["--name-only", "-z", "--no-renames"], trackedBinaryPaths), cwd)
    : [];
  const trackedSkipped = trackedBinaryPaths.map((filePath) => `${filePath} (binary)`);
  const untrackedFiles = headExists
    ? gitPathList(["ls-files", "-z", "--others", "--exclude-standard"], cwd)
    : gitPathList(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd);
  const untracked = buildUntrackedPatch(cwd, untrackedFiles);
  const patch = joinSections([trackedPatch, untracked.patch]);

  if (!patch.trim()) {
    const skipped = [...trackedSkipped, ...untracked.skipped];
    const skippedMessage = skipped.length > 0 ? ` Skipped files: ${skipped.join(", ")}.` : "";
    throw new Error(`No uncommitted changes to review.${skippedMessage}`);
  }

  return makeBundle({
    repoPath: cwd,
    baseSha,
    headSha: WORKING_HEAD_SHA,
    patch,
    patchStat: joinSections([trackedPatchStat, untracked.patchStat]),
    changedFiles: changedFilesFromPaths([...trackedPaths, ...untracked.paths]),
    reviewTarget: formatUncommittedReviewTarget(opts.pr, untracked.skipped, trackedSkipped),
    untrackedSkipped: untracked.untrackedSkipped,
    prMeta: opts.pr ? fetchPrMeta(cwd, opts.pr) : null,
    deep: Boolean(opts.deep),
    focus: opts.focus ?? null,
  });
}

export type LocalDiffMode = "uncommitted" | "branch";

export interface LocalBundle {
  readonly bundle: Bundle;
  readonly mode: LocalDiffMode;
}

/** A dirty worktree or a repo with no commits reviews uncommitted changes; a clean one reviews merge-base..HEAD. */
export function localDiffMode(
  headExists: boolean,
  dirty: boolean,
  override: LocalDiffMode | undefined,
): LocalDiffMode {
  return override ?? (!headExists || dirty ? "uncommitted" : "branch");
}

export function diffBundle(cwd: string, opts: LocalOptions): LocalBundle {
  ensureGitRepo(cwd);
  const headExists = hasHeadCommit(cwd);
  const dirty = git(["status", "--porcelain"], cwd).trim() !== "";
  const mode = localDiffMode(headExists, dirty, opts.localMode);
  const bundle = mode === "uncommitted" ? uncommittedDiffBundle(cwd, opts, headExists) : branchDiffBundle(cwd, opts);
  return { bundle, mode };
}

export function prDiffBundle(
  cwd: string,
  prNumber: number,
  opts: LocalOptions
): { bundle: Bundle; pr: PrRefInfo } {
  const pr = fetchPrRefInfo(cwd, prNumber);
  ensurePrCommits(cwd, pr);
  const diff = prDiffFromShas(cwd, pr.baseSha, pr.headSha);
  const bundle = makeBundle({
    repoPath: cwd,
    baseSha: diff.baseSha,
    headSha: diff.headSha,
    patch: diff.patch,
    patchStat: diff.patchStat,
    changedFiles: diff.changedFiles,
    reviewTarget: `Review target: PR #${pr.prMeta.number} ${diff.baseSha}..${diff.headSha}`,
    prMeta: pr.prMeta,
    deep: Boolean(opts.deep),
    focus: opts.focus ?? null,
    agentsMd: readAgentsAt(cwd, pr.headSha),
  });
  return { bundle, pr };
}

export interface LocalOptions extends RunnerOptions {
  readonly base?: string;
  readonly pr?: number;
  readonly deep?: boolean;
  readonly focus?: string;
  readonly cacheDir?: string;
  readonly localMode?: "uncommitted" | "branch";
}

export async function runLocal(
  cwd: string,
  opts: LocalOptions,
  onProgress?: ReviewProgressObserver
): Promise<ReviewResult> {
  const repoPath = path.resolve(cwd);
  const result = await review(diffBundle(repoPath, opts).bundle, opts, undefined, onProgress);
  writeCache(repoPath, opts, result);
  return result;
}

export async function runLocalPr(
  cwd: string,
  prNumber: number,
  opts: LocalOptions,
  onProgress?: ReviewProgressObserver
): Promise<ReviewResult> {
  const repoPath = path.resolve(cwd);
  const { bundle, pr } = prDiffBundle(repoPath, prNumber, opts);
  // prNumber/prBaseSha are attached after review(): anything on the bundle
  // reaches the model via {{BUNDLE}}, so these live only on the result.
  // pr.baseSha is baseRefOid — the PR base tip; bundle.baseSha is the merge base.
  const result: ReviewResult = {
    ...(await review(bundle, opts, undefined, onProgress)),
    prNumber: pr.prMeta.number,
    prBaseSha: pr.baseSha,
  };
  writeCache(repoPath, opts, result);
  return result;
}

export function printLocal(result: ReviewResult): void {
  process.stdout.write(renderMarkdown(result) + "\n");
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function progressLine(event: ReviewProgressEvent): string {
  switch (event.stage) {
    case "review":
      return `reviewing ${plural(event.files, "changed file")} in one pass`;
    case "map":
      return `mapping ${plural(event.files, "changed file")} to hotspots`;
    case "deep": {
      const tail = event.tail ? ", incl. tail-coverage" : "";
      const failed = event.failed > 0 ? `, ${event.failed} failed` : "";
      return event.done === 0
        ? `deep review: ${plural(event.total, "hotspot")}${tail}`
        : `deep review: ${event.done}/${event.total} done${failed}`;
    }
    case "dedup":
      return `merged ${plural(event.before, "candidate finding")}, ${event.after} after dedup`;
    case "critic":
      return `critic pass over ${plural(event.findings, "candidate finding")}`;
    case "done":
      return `done in ${(event.durationMs / 1000).toFixed(1)}s`;
  }
}

// Stage lines are for a person watching a terminal. Pipes, CI logs, and
// --json consumers (agents, hooks) must see the same stderr as before.
export function terminalProgress(
  stream: { readonly isTTY?: boolean; write(chunk: string): unknown },
  json: boolean
): ReviewProgressObserver | undefined {
  if (json || !stream.isTTY) return undefined;
  return (event) => {
    stream.write(`needlefish: ${progressLine(event)}\n`);
  };
}

// --- --dry-run: collect the bundle, report what a real run would do ---

export type DryRunMode = LocalDiffMode | "pr";

export interface DryRunReport {
  readonly mode: DryRunMode;
  readonly bundle: Bundle;
  readonly docsOnlyFastPath: boolean;
  readonly largePath: boolean;
}

// Bundle collection only — no review(), no writeCache. Callers decide how to
// render; --print-bundle emits the bundle itself, which is the whole diff and
// the repo AGENTS.md policy text verbatim.
export function localDryRun(cwd: string, opts: LocalOptions): DryRunReport {
  const { bundle, mode } = diffBundle(path.resolve(cwd), opts);
  return { mode, bundle, ...reviewPlan(bundle) };
}

export function localPrDryRun(cwd: string, prNumber: number, opts: LocalOptions): DryRunReport {
  const { bundle } = prDiffBundle(path.resolve(cwd), prNumber, opts);
  return { mode: "pr", bundle, ...reviewPlan(bundle) };
}

interface DryRunSummary {
  readonly mode: DryRunMode;
  readonly baseSha: string;
  readonly headSha: string;
  readonly reviewTarget?: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly patchBytes: number;
  readonly patchStat: string;
  readonly prMeta: { readonly present: boolean; readonly number?: number };
  readonly agentsMd: { readonly present: boolean; readonly bytes: number };
  readonly untrackedSkipped: readonly UntrackedSkippedFile[];
  readonly docsOnlyFastPath: boolean;
  readonly largePath: boolean;
}

// The redacted summary: everything needed to answer "was the evidence in the
// bundle?" except the patch and policy text themselves (those are behind
// --print-bundle).
function dryRunSummary(report: DryRunReport): DryRunSummary {
  const { bundle } = report;
  return {
    mode: report.mode,
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
    ...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
    changedFiles: bundle.changedFiles,
    patchBytes: Buffer.byteLength(bundle.patch),
    patchStat: bundle.patchStat,
    prMeta: bundle.prMeta
      ? { present: true, number: bundle.prMeta.number }
      : { present: false },
    agentsMd: {
      present: bundle.agentsMd !== NO_AGENTS,
      bytes: Buffer.byteLength(bundle.agentsMd),
    },
    untrackedSkipped: bundle.untrackedSkipped ?? [],
    docsOnlyFastPath: report.docsOnlyFastPath,
    largePath: report.largePath,
  };
}

export function printDryRun(
  report: DryRunReport,
  opts: { readonly json?: boolean; readonly printBundle?: boolean } = {}
): void {
  if (opts.printBundle) {
    process.stdout.write(`${JSON.stringify(report.bundle, null, 2)}\n`);
    return;
  }
  const summary = dryRunSummary(report);
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return;
  }
  const lines: string[] = [
    `mode: ${summary.mode}`,
    `baseSha: ${summary.baseSha}`,
    `headSha: ${summary.headSha}`,
  ];
  if (summary.reviewTarget) {
    const [first, ...rest] = summary.reviewTarget.split("\n");
    lines.push(`reviewTarget: ${first}`);
    for (const line of rest) lines.push(`  ${line}`);
  }
  lines.push(`changedFiles: ${summary.changedFiles.length}`);
  for (const file of summary.changedFiles) {
    lines.push(`  ${file.path} (${file.surface})`);
  }
  lines.push(`patchBytes: ${summary.patchBytes}`);
  const statLines = summary.patchStat.split("\n").filter((line) => line.trim());
  if (statLines.length > 0) {
    lines.push("patchStat:");
    for (const line of statLines) lines.push(`  ${line}`);
  } else {
    lines.push("patchStat: (empty)");
  }
  lines.push(
    `prMeta: ${summary.prMeta.present ? `present (#${summary.prMeta.number})` : "absent"}`
  );
  lines.push(
    `agentsMd: ${summary.agentsMd.present ? `present (${summary.agentsMd.bytes} bytes)` : "absent"}`
  );
  lines.push(`untrackedSkipped: ${summary.untrackedSkipped.length}`);
  for (const skipped of summary.untrackedSkipped) {
    lines.push(`  ${skipped.path} (${skipped.reason}, ${skipped.bytes} bytes)`);
  }
  lines.push(`docsOnlyFastPath: ${summary.docsOnlyFastPath}`);
  lines.push(`largePath: ${summary.largePath}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}
