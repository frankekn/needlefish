import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFinding, normalizeReview } from "./normalize";

test("normalizeFinding accepts a complete model finding", () => {
  const raw = {
    severity: "p2",
    title: "Rejects valid input",
    category: "validation",
    file: "src/app.ts",
    lineStart: 7,
    confidence: 0.8,
    whyItBreaks: "Valid input is rejected.",
    suggestedFix: "Accept the valid input.",
  };

  const finding = normalizeFinding(raw);

  assert.equal(finding.severity, "P2");
  assert.equal(finding.lineEnd, 7);
  assert.equal(finding.confidence, 0.8);
});

test("normalizeFinding rejects line ranges that run backward", () => {
  const raw = {
    severity: "P3",
    title: "Bad range",
    category: "bug",
    file: "src/app.ts",
    lineStart: 7,
    lineEnd: 6,
    whyItBreaks: "The cited range is invalid.",
    suggestedFix: "Fix the range.",
  };

  assert.throws(() => normalizeFinding(raw), /lineEnd before lineStart/);
});

test("normalizeFinding rejects low-confidence blocking findings", () => {
  const raw = {
    severity: "P2",
    title: "Weak blocker",
    category: "bug",
    file: "src/app.ts",
    lineStart: 1,
    confidence: 0.5,
    whyItBreaks: "Maybe breaks.",
    suggestedFix: "Maybe fix.",
  };

  assert.throws(() => normalizeFinding(raw), /blocking finding has low confidence/);
});

test("normalizeFinding rejects blocking confidence below prompt contract", () => {
  const raw = {
    severity: "P2",
    title: "Below contract blocker",
    category: "bug",
    file: "src/app.ts",
    lineStart: 1,
    confidence: 0.69,
    whyItBreaks: "Below-contract confidence should not block a PR.",
    suggestedFix: "Reject weak blocking confidence.",
  };

  assert.throws(() => normalizeFinding(raw), /blocking finding has low confidence/);
});

test("normalizeFinding rejects nonnumeric blocking confidence", () => {
  const raw = {
    severity: "P2",
    title: "Malformed blocker",
    category: "bug",
    file: "src/app.ts",
    lineStart: 1,
    confidence: "bad",
    whyItBreaks: "Invalid model output should not block a PR.",
    suggestedFix: "Reject malformed confidence.",
  };

  assert.throws(() => normalizeFinding(raw), /invalid confidence/);
});

test("normalizeReview rejects empty residual risk text", () => {
  const raw = {
    summary: "reviewed",
    findings: [],
    checked: ["diff"],
    residual_risks: [{ text: "", blocks: true }],
  };

  assert.throws(() => normalizeReview(raw), /residual risk text missing/);
});

test("normalizeReview drops malformed findings in loose mode", () => {
  const raw = {
    summary: "reviewed",
    findings: [
      {
        severity: "P3",
        title: "Small issue",
        category: "bug",
        file: "src/app.ts",
        lineStart: 1,
        whyItBreaks: "It breaks.",
        suggestedFix: "Fix it.",
      },
      { severity: "bad" },
    ],
    checked: ["diff"],
    residual_risks: [{ text: "none", blocks: false }],
  };

  const review = normalizeReview(raw, false);

  assert.equal(review.findings.length, 1);
  assert.deepEqual(review.checked, ["diff"]);
});
