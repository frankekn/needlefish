import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import {
  changedFiles,
  changedFilesFromPaths,
  ensurePrCommits,
  fetchPrRefInfo,
  ghText,
  git,
  makeBundle,
  prDiffFromShas,
  readAgentsAt,
} from "../shared/repo";
import { normalizePrMeta } from "../shared/normalize";
import { serializeReviewResult, type Bundle, type ReviewResult } from "../shared/schema";
import type { RunnerOptions } from "../shared/runner";
import {
  buildUntrackedPatch,
  EMPTY_BASE_SHA,
  formatUncommittedReviewTarget,
  joinSections,
  parseTrackedBinaryPathsFromNumstat,
  WORKING_HEAD_SHA,
} from "./local-uncommitted";

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

function ensureGitRepo(cwd: string): void {
  try {
    if (git(["rev-parse", "--is-inside-work-tree"], cwd) === "true") return;
  } catch (err) {
    if (!(err instanceof Error)) throw err;
  }
  throw new Error("This folder is not a git repository yet. Run `git init` inside your project folder first.");
}

function hasHeadCommit(cwd: string): boolean {
  try {
    git(["cat-file", "-e", "HEAD^{commit}"], cwd);
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function gitLines(args: readonly string[], cwd: string): string[] {
  return git(args, cwd).split("\n").filter(Boolean);
}

function gitNulFields(args: readonly string[], cwd: string): string[] {
  const output = git(args, cwd);
  if (!output) return [];
  const fields = output.endsWith("\0") ? output.slice(0, -1).split("\0") : output.split("\0");
  return fields.filter(Boolean);
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
        `--pr ${prNumber} requested, but PR metadata could not be fetched: ${err.message}. Check gh auth or remove --pr for local-only review.`
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
  const baseRef = detectBase(cwd, opts.base);
  const baseSha = git(["merge-base", baseRef, "HEAD"], cwd);
  const headSha = git(["rev-parse", "HEAD"], cwd);
  const patch = git(["diff", baseSha, "HEAD"], cwd);
  if (!patch.trim()) {
    throw new Error(
      `No diff between ${baseSha} and HEAD (${baseRef}). Nothing to review.`
    );
  }
  return makeBundle({
    repoPath: cwd,
    baseSha,
    headSha,
    patch,
    patchStat: git(["diff", "--stat", baseSha, "HEAD"], cwd),
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
  const trackedPatch = headExists ? git(trackedDiffArgs([], trackedBinaryPaths), cwd) : "";
  const trackedPatchStat = headExists ? git(trackedDiffArgs(["--stat"], trackedBinaryPaths), cwd) : "";
  const trackedPaths = headExists ? gitNulFields(trackedDiffArgs(["--name-only", "-z"], trackedBinaryPaths), cwd) : [];
  const trackedSkipped = trackedBinaryPaths.map((filePath) => `${filePath} (binary)`);
  const untrackedFiles = headExists
    ? gitLines(["ls-files", "--others", "--exclude-standard"], cwd)
    : gitLines(["ls-files", "--cached", "--others", "--exclude-standard"], cwd);
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
    prMeta: opts.pr ? fetchPrMeta(cwd, opts.pr) : null,
    deep: Boolean(opts.deep),
    focus: opts.focus ?? null,
  });
}

function diffBundle(cwd: string, opts: LocalOptions): Bundle {
  ensureGitRepo(cwd);
  const headExists = hasHeadCommit(cwd);
  const dirty = git(["status", "--porcelain"], cwd).trim() !== "";
  const mode = opts.localMode ?? (!headExists || dirty ? "uncommitted" : "branch");
  return mode === "uncommitted" ? uncommittedDiffBundle(cwd, opts, headExists) : branchDiffBundle(cwd, opts);
}

export function prDiffBundle(cwd: string, prNumber: number, opts: LocalOptions): Bundle {
  const pr = fetchPrRefInfo(cwd, prNumber);
  ensurePrCommits(cwd, pr);
  const diff = prDiffFromShas(cwd, pr.baseSha, pr.headSha);
  return makeBundle({
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
  opts: LocalOptions
): Promise<ReviewResult> {
  const repoPath = path.resolve(cwd);
  const result = await review(diffBundle(repoPath, opts), opts);
  writeCache(repoPath, opts, result);
  return result;
}

export async function runLocalPr(
  cwd: string,
  prNumber: number,
  opts: LocalOptions
): Promise<ReviewResult> {
  const repoPath = path.resolve(cwd);
  const result = await review(prDiffBundle(repoPath, prNumber, opts), opts);
  writeCache(repoPath, opts, result);
  return result;
}

export function printLocal(result: ReviewResult): void {
  process.stdout.write(renderMarkdown(result) + "\n");
}
