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
