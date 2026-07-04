import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./render";
import { REVIEW_RESULT_SCHEMA_VERSION, type Finding, type ReviewResult } from "./schema";

test("renderMarkdown includes review target disclosure", () => {
  const result: ReviewResult = {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    verdict: "pass",
    summary: "Clean.",
    findings: [],
    checked: ["diff"],
    residualRisks: [],
    baseSha: "base",
    headSha: "head",
    reviewTarget: "Review target: local base..head\nPR context: #24 metadata only",
  };

  const markdown = renderMarkdown(result);

  assert.match(markdown, /Review target: local base\.\.head/);
  assert.match(markdown, /PR context: #24 metadata only/);
});

test("renderMarkdown appends a stats summary line", () => {
  const result: ReviewResult = {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    verdict: "pass",
    summary: "Clean.",
    findings: [],
    checked: ["diff"],
    residualRisks: [],
    baseSha: "base",
    headSha: "head",
    stats: [
      { label: "review", runner: "codex", durationMs: 212000, attempts: 2, ok: true },
      { label: "critic", runner: "codex", durationMs: 96000, attempts: 1, ok: true },
    ],
    totalDurationMs: 308000,
  };

  const markdown = renderMarkdown(result);

  assert.match(markdown, /2 calls · review 3m 32s → critic 1m 36s · 1 retry · total 5m 8s/);
});

function baseResult(findings: readonly Finding[]): ReviewResult {
  return {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    verdict: "changes_requested",
    summary: "s",
    findings,
    checked: ["checked"],
    residualRisks: [],
    baseSha: "base",
    headSha: "head",
  };
}

function finding(severity: Finding["severity"], title: string, file: string): Finding {
  return {
    severity,
    title,
    category: "bug",
    file,
    lineStart: 1,
    lineEnd: 1,
    confidence: 0.9,
    whyItBreaks: "w",
    suggestedFix: "f",
    validation: "v",
  };
}

test("renderMarkdown with inlinedFindings renders one-line entries and full blocks for the rest", () => {
  const inlined = finding("P2", "in diff", "a.ts");
  const outside = finding("P3", "outside", "b.ts");
  const result = baseResult([inlined, outside]);

  const markdown = renderMarkdown(result, { inlinedFindings: new Set([inlined]) });

  assert.match(markdown, /- \*\*P2\*\* in diff — a\.ts:1/);
  assert.match(markdown, /## Findings outside the diff/);
  assert.match(markdown, /### P3: outside/);
  assert.doesNotMatch(markdown, /### P2: in diff/);
});

test("renderMarkdown without opts is unchanged (full blocks for every finding)", () => {
  const a = finding("P2", "a", "a.ts");
  const b = finding("P3", "b", "b.ts");
  const result = baseResult([a, b]);

  const markdown = renderMarkdown(result);

  assert.match(markdown, /### P2: a/);
  assert.match(markdown, /### P3: b/);
  assert.doesNotMatch(markdown, /## Findings outside the diff/);
  assert.doesNotMatch(markdown, /- \*\*P2\*\*/);
});
