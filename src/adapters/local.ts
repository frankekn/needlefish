import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import {
  changedFiles,
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

function diffBundle(cwd: string, opts: LocalOptions): Bundle {
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
