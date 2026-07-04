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

test("normalizeFinding keeps a valid replacement", () => {
  const raw = {
    severity: "P2",
    title: "Wrong branch",
    category: "bug",
    file: "src/app.ts",
    lineStart: 3,
    lineEnd: 4,
    confidence: 0.9,
    whyItBreaks: "The branch returns the wrong value.",
    suggestedFix: "Replace the branch.",
    replacement: { lines: ["  return ok;", "}"] },
  };

  const finding = normalizeFinding(raw);

  assert.deepEqual(finding.replacement, { lines: ["  return ok;", "}"] });
});

test("normalizeFinding drops malformed replacement but keeps finding", () => {
  const base = {
    severity: "P2",
    title: "Wrong branch",
    category: "bug",
    file: "src/app.ts",
    lineStart: 3,
    confidence: 0.9,
    whyItBreaks: "The branch returns the wrong value.",
    suggestedFix: "Replace the branch.",
  };

  for (const replacement of [
    { lines: "return ok;" },
    { lines: ["return ok;", 1] },
    { lines: [] },
  ]) {
    const finding = normalizeFinding({ ...base, replacement });

    assert.equal(finding.title, "Wrong branch");
    assert.equal(finding.replacement, undefined);
  }
});

test("normalizeReview keeps old JSON output unchanged without replacement", () => {
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
    ],
    checked: ["diff"],
    residual_risks: [],
  };

  const review = normalizeReview(raw);

  assert.equal(JSON.stringify(review), JSON.stringify({
    summary: "reviewed",
    findings: [
      {
        severity: "P3",
        category: "bug",
        file: "src/app.ts",
        title: "Small issue",
        whyItBreaks: "It breaks.",
        suggestedFix: "Fix it.",
        lineStart: 1,
        lineEnd: 1,
        confidence: 0,
        validation: "",
      },
    ],
    checked: ["diff"],
    residual_risks: [],
  }));
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
