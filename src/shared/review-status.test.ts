import assert from "node:assert/strict";
import test from "node:test";
import { deriveVerdict } from "../core/verdict.js";
import { renderMarkdown } from "./render.js";
import { reviewStatus } from "./review-status.js";
import { serializeReviewResult, type Finding, type ReviewResult } from "./schema.js";

const finding: Finding = {
  severity: "P2", category: "bug", title: "Wrong result", file: "src/a.ts",
  lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: "Returns the wrong value",
  suggestedFix: "Restore the value", validation: "Inspect the changed return",
};

const incomplete: ReviewResult = {
  schemaVersion: 1, verdict: "needs_human", summary: "Some files could not be checked.",
  findings: [], checked: ["src/a.ts"], baseSha: "base", headSha: "head",
  residualRisks: [{ text: "src/b.ts was not deep-reviewed", blocks: true }],
  coverage: "1/2 changed files deep-reviewed",
};

test("only pass satisfies the delivery policy", () => {
  assert.deepEqual(reviewStatus("pass"), { exitCode: 0, conclusion: "success" });
  for (const verdict of ["changes_requested", "needs_human"] as const) {
    assert.deepEqual(reviewStatus(verdict), { exitCode: 1, conclusion: "failure" });
  }
});

test("severity and blocking-residual derivation stay unchanged", () => {
  for (const severity of ["P0", "P1", "P2"] as const) {
    const verdict = deriveVerdict([{ ...finding, severity }], []);
    assert.equal(verdict, "changes_requested");
    assert.equal(reviewStatus(verdict).exitCode, 1);
  }
  const nonBlocking = [{ text: "Optional follow-up", blocks: false }];
  assert.equal(deriveVerdict([{ ...finding, severity: "P3" }], nonBlocking), "pass");
  assert.equal(deriveVerdict([], nonBlocking), "pass");
  assert.equal(deriveVerdict([], incomplete.residualRisks), "needs_human");
  assert.equal(deriveVerdict([finding], incomplete.residualRisks), "changes_requested");
});

test("incomplete Markdown explains the next step and preserves machine data", () => {
  const before = serializeReviewResult(incomplete);
  const text = renderMarkdown(incomplete);
  assert.match(text, /^NEEDS HUMAN/);
  assert.match(text, /Review incomplete — human confirmation required/);
  assert.match(text, /not a pass or a confirmed code defect/);
  assert.match(text, /Retry the review/);
  assert.match(text, /ask a developer/);
  assert.match(text, /src\/b.ts was not deep-reviewed/);
  assert.match(text, /Coverage: 1\/2/);
  assert.match(text, /not an approval/);
  assert.equal(serializeReviewResult(incomplete), before);
});

test("pass and code-defect results do not get the incomplete-review notice", () => {
  for (const verdict of ["pass", "changes_requested"] as const) {
    const text = renderMarkdown({ ...incomplete, verdict, residualRisks: [],
      findings: verdict === "pass" ? [] : [finding], summary: "Review finished." });
    assert.doesNotMatch(text, /Review incomplete|not an approval/);
  }
});

test("docs policy bypass still discloses that no model reviewed the change", () => {
  const text = renderMarkdown({ ...incomplete, verdict: "pass", residualRisks: [],
    summary: "Docs-only change (1 file(s)); model review skipped.",
    checked: ["FAST_PATH docs-only files=[README.md]"], coverage: undefined });
  assert.match(text, /model review skipped/);
  assert.equal(reviewStatus("pass").exitCode, 0);
});
