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
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}

const VERDICT_EVENT: Record<Verdict, "APPROVE" | "REQUEST_CHANGES" | "COMMENT"> = {
  pass: "APPROVE",
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

  const pr = gh([
    "api",
    `repos/${repo}/pulls/${prNumber}`,
  ]);
  const headSha = pr.head?.sha ?? git(["rev-parse", "HEAD"], cwd);
  const baseSha = pr.base?.sha ?? git(["merge-base", "origin/" + (pr.base?.ref ?? "main"), "HEAD"], cwd);

  const patch = ghText(["pr", "diff", String(prNumber)]);
  const changedFiles = changedFileSet(cwd, baseSha);
  const changedPaths = new Set(changedFiles.map((f) => f.path));

  const agentsPath = path.join(cwd, "AGENTS.md");
  const agentsMd = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : null;

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
    baseSha,
    headSha,
    patch,
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
      "neutral",
      "Needlefish: review failed",
      `Review errored and did NOT pass this PR.\n\n\`\`\`\n${msg.slice(0, 4000)}\n\`\`\``
    );
    process.stderr.write(`needlefish review failed: ${msg}\n`);
    process.exitCode = 1;
  }
}
