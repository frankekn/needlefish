import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import { changedFiles, ghText, git, makeBundle } from "../shared/repo";
import { normalizeBodyList } from "../shared/normalize";
import type {
  ReviewResult,
  Verdict,
} from "../shared/schema";

type JsonRecord = Record<string, unknown>;

function isRecord(raw: unknown): raw is JsonRecord {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function ghJson(args: readonly string[], input?: string): unknown {
  const out = ghText(args, undefined, input);
  return out ? JSON.parse(out) : {};
}

function stringField(raw: JsonRecord, field: string): string {
  const value = raw[field];
  return typeof value === "string" ? value : "";
}

function nestedString(raw: JsonRecord, field: string, nestedField: string): string {
  const value = raw[field];
  return isRecord(value) ? stringField(value, nestedField) : "";
}

const VERDICT_EVENT: Record<Verdict, "COMMENT" | "REQUEST_CHANGES"> = {
  pass: "COMMENT",
  changes_requested: "REQUEST_CHANGES",
  needs_human: "COMMENT",
};

const VERDICT_CONCLUSION: Record<Verdict, "success" | "failure" | "neutral"> = {
  pass: "success",
  changes_requested: "failure",
  needs_human: "neutral",
};

function postReview(
  repo: string,
  prNumber: number,
  headSha: string,
  result: ReviewResult
) {
  const event = VERDICT_EVENT[result.verdict];
  const body = renderMarkdown(result);
  const repoArg = `repos/${repo}`;

  const payload = JSON.stringify({
    commit_id: headSha,
    body,
    event,
    comments: [],
  });

  ghJson(
    ["api", "-X", "POST", `${repoArg}/pulls/${prNumber}/reviews`, "--input", "-"],
    payload
  );
}

function postCheck(
  repo: string,
  headSha: string,
  result: ReviewResult | null,
  conclusion: "success" | "failure" | "neutral",
  title: string,
  summary: string
) {
  ghJson(
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

  const pr = ghJson(["api", `repos/${repo}/pulls/${prNumber}`]);
  if (!isRecord(pr)) throw new Error("GitHub PR response was not an object");
  const headSha = process.env.PR_HEAD_SHA || nestedString(pr, "head", "sha") || git(["rev-parse", "HEAD"], cwd);
  const baseSha = process.env.PR_BASE_SHA || nestedString(pr, "base", "sha");
  if (!baseSha || !headSha) throw new Error("Could not resolve PR base/head SHA");
  const mergeBase = git(["merge-base", baseSha, headSha], cwd);
  const patch = git(["diff", mergeBase, headSha], cwd);
  if (!patch.trim()) {
    throw new Error(`No diff between ${mergeBase} and ${headSha}. Nothing to review.`);
  }
  const patchStat = git(["diff", "--stat", mergeBase, headSha], cwd);
  const changed = changedFiles(cwd, mergeBase, headSha);

  const commentsUrl = stringField(pr, "comments_url");
  const reviewsUrl = stringField(pr, "review_comments_url");
  const comments = commentsUrl ? ghJson(["api", commentsUrl]) : [];
  const reviews = reviewsUrl ? ghJson(["api", reviewsUrl]) : [];

  const prMeta = {
    number: prNumber,
    title: stringField(pr, "title"),
    body: typeof pr.body === "string" ? pr.body : null,
    comments: normalizeBodyList(comments),
    reviews: normalizeBodyList(reviews),
    checks: [],
  };

  const bundle = makeBundle({
    repoPath: cwd,
    baseSha: mergeBase,
    headSha,
    patch,
    patchStat,
    changedFiles: changed,
    prMeta,
    deep: false,
    focus: null,
  });

  let result: ReviewResult | null = null;
  try {
    result = await review(bundle);
    const conclusion = VERDICT_CONCLUSION[result.verdict];
    postReview(repo, prNumber, headSha, result);
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
