import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyFiles } from "../shared/classify";
import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import type {
  Bundle,
  PrMeta,
  ReviewResult,
  Verdict,
  Finding,
} from "../shared/schema";

function gh(args: string[], input?: string): any {
  const res = spawnSync("gh", args, {
    encoding: "utf8",
    input,
    maxBuffer: 1024 * 1024 * 64,
  });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  const out = (res.stdout ?? "").trim();
  return out ? JSON.parse(out) : {};
}

function ghText(args: string[]): string {
  const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  if (res.status !== 0) {
    throw new Error(`gh ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}

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

const VERDICT_EVENT: Record<Verdict, "COMMENT" | "REQUEST_CHANGES" | "COMMENT"> = {
  pass: "COMMENT",
  changes_requested: "REQUEST_CHANGES",
  needs_human: "COMMENT",
};

const VERDICT_CONCLUSION: Record<string, "success" | "failure" | "neutral"> = {
  pass: "success",
  changes_requested: "failure",
  needs_human: "neutral",
};

function changedFileSet(cwd: string, baseSha: string): { path: string; surface: any }[] {
  const nameOnly = git(["diff", "--name-only", baseSha, "HEAD"], cwd);
  return classifyFiles(nameOnly.split("\n").filter(Boolean));
}

function inlineComments(findings: Finding[], changedPaths: Set<string>) {
  return findings
    .filter((f) => f.file && changedPaths.has(f.file) && f.lineStart > 0)
    .map((f) => ({
      path: f.file,
      line: f.lineStart,
      side: "RIGHT" as const,
      body: `**${f.severity} (${f.category}): ${f.title}**\n\n${f.whyItBreaks}\n\n_Suggested fix:_ ${f.suggestedFix}`,
    }));
}

function postReview(
  repo: string,
  prNumber: number,
  headSha: string,
  result: ReviewResult,
  changedPaths: Set<string>
) {
  const event = VERDICT_EVENT[result.verdict];
  const body = renderMarkdown(result);
  const comments = inlineComments(result.findings, changedPaths);
  const repoArg = `repos/${repo}`;

  const payload = JSON.stringify({
    commit_id: headSha,
    body,
    event,
    comments,
  });

  try {
    gh(
      ["api", "-X", "POST", `${repoArg}/pulls/${prNumber}/reviews`, "--input", "-"],
      payload
    );
  } catch {
    gh(
      [
        "api",
        "-X",
        "POST",
        `${repoArg}/pulls/${prNumber}/reviews`,
        "-f",
        `event=${event}`,
        "-f",
        `commit_id=${headSha}`,
        "-f",
        `body=${body}`,
      ]
    );
  }
}

function postCheck(
  repo: string,
  headSha: string,
  result: ReviewResult | null,
  conclusion: "success" | "failure" | "neutral",
  title: string,
  summary: string
) {
  gh(
    ["api", "-X", "POST", `repos/${repo}/check-runs`, "--input", "-"],
    JSON.stringify({
      name: "Needlefish",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: { title, summary },
    })
  );
}

export async function runGithub(cwd: string, prNumber: number): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY not set (must run in Actions)");

  const pr = gh(["api", `repos/${repo}/pulls/${prNumber}`]);
  const headSha = process.env.PR_HEAD_SHA || git(["rev-parse", "HEAD"], cwd);
  const baseSha = process.env.PR_BASE_SHA || git(["merge-base", "origin/main", "HEAD"], cwd);
  const mergeBase = git(["merge-base", baseSha, headSha], cwd);
  const patch = git(["diff", mergeBase, headSha], cwd);
  const patchStat = git(["diff", "--stat", mergeBase, headSha], cwd);
  const changedFiles = changedFileSet(cwd, mergeBase);
  const changedPaths = new Set(changedFiles.map((f) => f.path));

  const agentsPath = path.join(cwd, "AGENTS.md");
  const agentsMd = existsSync(agentsPath)
    ? readFileSync(agentsPath, "utf8")
    : "(no AGENTS.md in this repo — apply only generic senior-engineer review judgment; do NOT substitute any global/CLI-injected instructions file as policy)";

  const comments = (pr.comments_url
    ? gh(["api", pr.comments_url])
    : []) as any[];
  const reviews = (pr.review_comments_url
    ? gh(["api", pr.review_comments_url])
    : []) as any[];

  const prMeta: PrMeta = {
    number: prNumber,
    title: pr.title ?? "",
    body: pr.body ?? null,
    comments: comments.map((c) => c.body ?? "").filter(Boolean),
    reviews: reviews.map((r) => r.body ?? "").filter(Boolean),
    checks: [],
  };

  const bundle: Bundle = {
    repoPath: cwd,
    baseSha: mergeBase,
    headSha,
    patch,
    patchStat,
    changedFiles,
    agentsMd,
    prMeta,
    deep: false,
    focus: null,
  };

  let result: ReviewResult | null = null;
  try {
    result = await review(bundle);
    const conclusion = VERDICT_CONCLUSION[result.verdict];
    postReview(repo, prNumber, headSha, result, changedPaths);
    postCheck(repo, headSha, result, conclusion, `Needlefish: ${result.verdict}`, renderMarkdown(result));
    process.stdout.write(renderMarkdown(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    postCheck(
      repo,
      headSha,
      null,
      "failure",
      "Needlefish: review failed",
      `Review errored and did NOT pass this PR.\n\n\`\`\`\n${msg.slice(0, 4000)}\n\`\`\``
    );
    process.stderr.write(`needlefish review failed: ${msg}\n`);
    process.exitCode = 1;
  }
}
