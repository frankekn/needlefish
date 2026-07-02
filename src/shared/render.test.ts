import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./render";
import type { ReviewResult } from "./schema";

test("renderMarkdown includes review target disclosure", () => {
  const result: ReviewResult = {
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
