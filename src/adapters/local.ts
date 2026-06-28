import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyFiles } from "../shared/classify";
import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import type { Bundle, PrMeta, ReviewResult } from "../shared/schema";

function git(args: string[], cwd: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}

function detectBase(cwd: string, override?: string): string {
  if (override) return override;
  try {
    const head = git(
      ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
      cwd
    );
    if (head) return head;
  } catch {
    /* fall through */
  }
  return "main";
}

function gh(args: string[], cwd: string): string {
  const res = spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}

function fetchPrMeta(cwd: string, prNumber: number): PrMeta | null {
  try {
    const raw = gh(
      [
        "pr",
        "view",
        String(prNumber),
        "--json",
        "number,title,body,comments,reviews,statusCheckRollup",
      ],
      cwd
    );
    const j = JSON.parse(raw);
    return {
      number: j.number,
      title: j.title ?? "",
      body: j.body ?? null,
      comments: (j.comments ?? []).map((c: any) => c.body ?? "").filter(Boolean),
      reviews: (j.reviews ?? []).map((r: any) => r.body ?? "").filter(Boolean),
      checks: (j.statusCheckRollup ?? []).map((c: any) => ({
        name: c.name ?? c.context ?? "",
        status: c.status ?? "",
        conclusion: c.conclusion ?? null,
      })),
    };
  } catch {
    return null;
  }
}

function repoSlug(cwd: string): string {
  try {
    const url = git(["config", "--get", "remote.origin.url"], cwd);
    const m = url.match(/[:/]([^/]+)\/([^/]+?)(\.git)?$/);
    if (m) return `${m[1]}-${m[2]}`;
  } catch {
    /* ignore */
  }
  return path.basename(cwd);
}

export interface LocalOptions {
  base?: string;
  pr?: number;
  deep?: boolean;
  focus?: string;
  cacheDir?: string;
}

export async function runLocal(
  cwd: string,
  opts: LocalOptions
): Promise<ReviewResult> {
  const baseRef = detectBase(cwd, opts.base);
  const baseSha = git(["merge-base", baseRef, "HEAD"], cwd);
  const headSha = git(["rev-parse", "HEAD"], cwd);
  const patch = git(["diff", baseSha, "HEAD"], cwd);
  const patchStat = git(["diff", "--stat", baseSha, "HEAD"], cwd);
  const nameOnly = git(["diff", "--name-only", baseSha, "HEAD"], cwd);
  const changedFiles = classifyFiles(
    nameOnly.split("\n").filter(Boolean)
  );

  if (!patch.trim()) {
    throw new Error(
      `No diff between ${baseSha} and HEAD (${baseRef}). Nothing to review.`
    );
  }

  const agentsPath = path.join(cwd, "AGENTS.md");
  const agentsMd = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf8")
    : "(no AGENTS.md in this repo — apply only generic senior-engineer review judgment; do NOT substitute any global/CLI-injected instructions file as policy)";

  const prMeta = opts.pr ? fetchPrMeta(cwd, opts.pr) : null;

  const bundle: Bundle = {
    repoPath: cwd,
    baseSha,
    headSha,
    patch,
    patchStat,
    changedFiles,
    agentsMd,
    prMeta,
    deep: Boolean(opts.deep),
    focus: opts.focus ?? null,
  };

  const result = await review(bundle);

  const cache = opts.cacheDir ?? path.join(os.homedir(), ".cache", "needlefish", repoSlug(cwd));
  mkdirSync(cache, { recursive: true });
  writeFileSync(path.join(cache, "last-review.json"), JSON.stringify(result, null, 2));

  return result;
}

export function printLocal(result: ReviewResult): void {
  process.stdout.write(renderMarkdown(result) + "\n");
}
