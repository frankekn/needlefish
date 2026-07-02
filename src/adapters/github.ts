import path from "node:path";
import { review } from "../core/review";
import { renderMarkdown } from "../shared/render";
import { changedFiles, ghText, git, makeBundle } from "../shared/repo";
import { normalizeBodyList } from "../shared/normalize";
import type {
  Finding,
  ReviewResult,
  Verdict,
} from "../shared/schema";
import type { RunnerOptions } from "../shared/runner";

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

const VERDICT_CONCLUSION: Record<Verdict, "success" | "failure" | "neutral"> = {
  pass: "success",
  changes_requested: "failure",
  needs_human: "neutral",
};

// Parse a unified diff into head-side (new) line ranges per file path.
// For each `+++ b/<path>`, hunk headers `@@ -a,b +c,d @@` yield [c, c+d-1];
// d defaults to 1 when omitted. Deleted files (`+++ /dev/null`) are skipped.
export function headLinesInPatch(
  patch: string
): Map<string, Array<[number, number]>> {
  const ranges = new Map<string, Array<[number, number]>>();
  let file: string | null = null;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const m = /^\+\+\+ b\/(.+)$/.exec(raw);
      file = m ? m[1] : null;
      if (file && !ranges.has(file)) ranges.set(file, []);
      continue;
    }
    if (file && raw.startsWith("@@")) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (h) {
        const c = Number(h[1]);
        const d = h[2] === undefined ? 1 : Number(h[2]);
        if (d > 0) ranges.get(file)!.push([c, c + d - 1]);
      }
    }
  }
  return ranges;
}

export function anchorableIn(
  ranges: Map<string, Array<[number, number]>>,
  file: string,
  line: number
): boolean {
  const rs = ranges.get(file);
  if (!rs) return false;
  return rs.some(([start, end]) => line >= start && line <= end);
}

// --- Cross-round review state ---
// Title normalizer mirrors dedup() in src/core/review.ts (same idea, duplicated
// locally to keep the adapter layer free of core imports).
function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 60);
}

export interface FindingKey {
  readonly file: string;
  readonly lineStart: number;
  readonly category: string;
  readonly title: string;
}

export interface RoundState {
  readonly v: 1;
  readonly headSha: string;
  readonly findings: readonly FindingKey[];
}

function findingKey(f: Finding): FindingKey {
  return {
    file: f.file,
    lineStart: f.lineStart,
    category: f.category,
    title: normalizeTitle(f.title),
  };
}

export function renderState(headSha: string, findings: readonly Finding[]): string {
  const state: RoundState = { v: 1, headSha, findings: findings.map(findingKey) };
  return `<!-- needlefish-state: ${JSON.stringify(state)} -->`;
}

const STATE_PREFIX = "<!-- needlefish-state:";

export function parseState(body: string): RoundState | null {
  const start = body.lastIndexOf(STATE_PREFIX);
  if (start < 0) return null;
  const jsonStart = start + STATE_PREFIX.length;
  const end = body.indexOf("-->", jsonStart);
  if (end < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(jsonStart, end));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.v !== 1) return null;
  const headSha = raw.headSha;
  if (typeof headSha !== "string") return null;
  const findingsRaw = raw.findings;
  if (!Array.isArray(findingsRaw)) return null;
  const keys: FindingKey[] = [];
  for (const item of findingsRaw) {
    if (!isRecord(item)) return null;
    const { file, lineStart, category, title } = item;
    if (
      typeof file !== "string" ||
      typeof lineStart !== "number" ||
      typeof category !== "string" ||
      typeof title !== "string"
    ) {
      return null;
    }
    keys.push({ file, lineStart, category, title });
  }
  return { v: 1, headSha, findings: keys };
}

export interface MatchResult {
  readonly fresh: readonly Finding[];
  readonly open: readonly Finding[];
  readonly resolvedCount: number;
}

export function matchFindings(
  prevKeys: readonly FindingKey[],
  curr: readonly Finding[]
): MatchResult {
  const matched = new Set<number>();
  let resolvedCount = 0;
  for (const prev of prevKeys) {
    let hit = -1;
    for (let i = 0; i < curr.length; i++) {
      if (matched.has(i)) continue;
      const c = curr[i];
      if (
        c.file === prev.file &&
        c.category === prev.category &&
        normalizeTitle(c.title) === prev.title &&
        Math.abs(c.lineStart - prev.lineStart) <= 10
      ) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) matched.add(hit);
    else resolvedCount++;
  }
  const fresh: Finding[] = [];
  const open: Finding[] = [];
  curr.forEach((f, i) => {
    (matched.has(i) ? open : fresh).push(f);
  });
  return { fresh, open, resolvedCount };
}

type InlineComment = {
  readonly path: string;
  readonly line: number;
  readonly side: "RIGHT";
  readonly body: string;
};

function formatInlineComment(f: Finding): string {
  const lines = [
    `**${f.severity}** ${f.title}`,
    "",
    f.whyItBreaks,
    "",
    `**Fix:** ${f.suggestedFix}`,
  ];
  if (f.validation) lines.push("", `**Validate:** ${f.validation}`);
  return lines.join("\n");
}

function buildInlineComments(
  result: ReviewResult,
  patch: string
): { comments: InlineComment[]; inlined: Set<Finding> } {
  const ranges = headLinesInPatch(patch);
  const anchorable = result.findings.filter(
    (f) => f.file !== "" && anchorableIn(ranges, f.file, f.lineStart)
  );
  const selected =
    anchorable.length > 20
      ? anchorable.filter(
          (f) => f.severity === "P0" || f.severity === "P1" || f.severity === "P2"
        )
      : anchorable;
  const inlined = new Set<Finding>(selected);
  const comments: InlineComment[] = selected.map((f) => ({
    path: f.file,
    line: f.lineStart,
    side: "RIGHT",
    body: formatInlineComment(f),
  }));
  return { comments, inlined };
}

function postReview(
  repo: string,
  prNumber: number,
  headSha: string,
  body: string,
  comments: readonly InlineComment[]
): void {
  const payload = JSON.stringify({
    commit_id: headSha,
    body,
    event: "COMMENT",
    comments,
  });

  ghJson(
    ["api", "-X", "POST", `repos/${repo}/pulls/${prNumber}/reviews`, "--input", "-"],
    payload
  );
}

function updateReviewBody(
  repo: string,
  prNumber: number,
  reviewId: number,
  body: string
): void {
  ghJson(
    ["api", "-X", "PUT", `repos/${repo}/pulls/${prNumber}/reviews/${reviewId}`, "--input", "-"],
    JSON.stringify({ body })
  );
}

function findPreviousReview(
  repo: string,
  prNumber: number
): { id: number; state: RoundState } | null {
  const raw = ghJson(["api", `repos/${repo}/pulls/${prNumber}/reviews`]);
  if (!Array.isArray(raw)) return null;
  for (let i = raw.length - 1; i >= 0; i--) {
    const item = raw[i];
    if (!isRecord(item)) continue;
    const state = parseState(stringField(item, "body"));
    if (!state) continue;
    const id = item.id;
    if (typeof id !== "number") continue;
    return { id, state };
  }
  return null;
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

function isCurrentOpenHead(repo: string, prNumber: number, headSha: string): boolean {
  const pr = ghJson(["api", `repos/${repo}/pulls/${prNumber}`]);
  if (!isRecord(pr)) throw new Error("GitHub PR response was not an object");
  const state = stringField(pr, "state");
  if (state !== "open") {
    process.stdout.write(`Needlefish skipped posting for PR #${prNumber} because state is ${state || "unknown"}.\n`);
    return false;
  }
  const currentHeadSha = nestedString(pr, "head", "sha");
  if (currentHeadSha !== headSha) {
    process.stdout.write(`Needlefish skipped stale result for PR #${prNumber}: ${headSha} is no longer current.\n`);
    return false;
  }
  return true;
}

export async function runGithub(
  cwd: string,
  prNumber: number,
  opts: RunnerOptions = {}
): Promise<void> {
  const repoPath = path.resolve(cwd);
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY not set (must run in Actions)");

  const pr = ghJson(["api", `repos/${repo}/pulls/${prNumber}`]);
  if (!isRecord(pr)) throw new Error("GitHub PR response was not an object");
  const state = stringField(pr, "state");
  if (state !== "open") {
    process.stdout.write(`Needlefish skipped PR #${prNumber} because state is ${state || "unknown"}.\n`);
    return;
  }
  const headSha = process.env.PR_HEAD_SHA || nestedString(pr, "head", "sha") || git(["rev-parse", "HEAD"], repoPath);
  const baseSha = process.env.PR_BASE_SHA || nestedString(pr, "base", "sha");
  if (!baseSha || !headSha) throw new Error("Could not resolve PR base/head SHA");
  const mergeBase = git(["merge-base", baseSha, headSha], repoPath);
  const patch = git(["diff", mergeBase, headSha], repoPath);
  if (!patch.trim()) {
    throw new Error(`No diff between ${mergeBase} and ${headSha}. Nothing to review.`);
  }
  const patchStat = git(["diff", "--stat", mergeBase, headSha], repoPath);
  const changed = changedFiles(repoPath, mergeBase, headSha);

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
    repoPath,
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
    result = await review(bundle, opts);
    const conclusion = VERDICT_CONCLUSION[result.verdict];
    if (!isCurrentOpenHead(repo, prNumber, headSha)) return;
    if (result.verdict === "changes_requested") process.exitCode = 1;

    const prev = findPreviousReview(repo, prNumber);

    if (prev) {
      const { fresh, open, resolvedCount } = matchFindings(prev.state.findings, result.findings);
      const freshResult: ReviewResult = { ...result, findings: fresh };
      const { comments: freshComments, inlined: freshInlined } = buildInlineComments(freshResult, patch);
      const renderOpts = {
        inlinedFindings: freshInlined,
        openFindings: open,
        resolvedCount,
      };
      const body = renderMarkdown(freshResult, {
        ...renderOpts,
        stateMarker: renderState(headSha, result.findings),
      });
      updateReviewBody(repo, prNumber, prev.id, body);
      if (freshComments.length > 0) {
        postReview(repo, prNumber, headSha, "", freshComments);
      }
      const summary = renderMarkdown(freshResult, renderOpts);
      postCheck(repo, headSha, result, conclusion, `Needlefish: ${result.verdict}`, summary);
      process.stdout.write(summary);
    } else {
      const { comments, inlined } = buildInlineComments(result, patch);
      const body = renderMarkdown(result, {
        inlinedFindings: inlined,
        stateMarker: renderState(headSha, result.findings),
      });
      postReview(repo, prNumber, headSha, body, comments);
      const summary = renderMarkdown(result, { inlinedFindings: inlined });
      postCheck(repo, headSha, result, conclusion, `Needlefish: ${result.verdict}`, summary);
      process.stdout.write(summary);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isCurrentOpenHead(repo, prNumber, headSha)) {
      postCheck(
        repo,
        headSha,
        null,
        "failure",
        "Needlefish: review failed",
        `Review errored and did NOT pass this PR.\n\n\`\`\`\n${msg.slice(0, 4000)}\n\`\`\``
      );
    }
    process.stderr.write(`needlefish review failed: ${msg}\n`);
    process.exitCode = 1;
  }
}
