import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import { changedFiles, ghText, git, makeBundle } from "../shared/repo";
import { normalizePrMeta } from "../shared/normalize";
import type { ReviewResult } from "../shared/schema";
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
    if (err instanceof Error) return null;
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

function diffBundle(cwd: string, opts: LocalOptions) {
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
    prMeta: opts.pr ? fetchPrMeta(cwd, opts.pr) : null,
    deep: Boolean(opts.deep),
    focus: opts.focus ?? null,
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
  const result = await review(diffBundle(cwd, opts), opts);
  const cache = opts.cacheDir ?? path.join(os.homedir(), ".cache", "needlefish", cacheSlug(cwd));
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "last-review.json"), JSON.stringify(result, null, 2));

  return result;
}

export function printLocal(result: ReviewResult): void {
  process.stdout.write(renderMarkdown(result) + "\n");
}
