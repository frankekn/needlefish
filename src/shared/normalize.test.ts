import assert from "node:assert/strict";
import test from "node:test";
import { deriveVerdict } from "../core/verdict";
import { normalizeBodyList, normalizeFinding, normalizeMap, normalizePrMeta, normalizeReview } from "./normalize";

test("normalizeMap accepts a summary with no hotspots", () => {
  const map = normalizeMap({ summary: "reviewed", hotspots: [] });

  assert.deepEqual(map, { summary: "reviewed", hotspots: [] });
});

test("normalizeMap keeps a complete hotspot with normalized edges", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      {
        name: "API boundary",
        files: ["src/api.ts"],
        why: "Shared input validation.",
        risk: "high",
        edges: [
          {
            producer: "src/api.ts",
            consumerFile: "src/app.ts",
            consumerLine: "42",
            why: "The app consumes the parsed shape.",
          },
        ],
      },
    ],
  });

  assert.deepEqual(map.hotspots, [
    {
      name: "API boundary",
      files: ["src/api.ts"],
      why: "Shared input validation.",
      risk: "high",
      edges: [
        {
          producer: "src/api.ts",
          consumerFile: "src/app.ts",
          consumerLine: 42,
          why: "The app consumes the parsed shape.",
        },
      ],
    },
  ]);
});

test("normalizeMap rejects missing or invalid summary", () => {
  for (const raw of [
    null,
    { hotspots: [] },
    { summary: 1, hotspots: [] },
  ]) {
    assert.throws(() => normalizeMap(raw), /malformed map output/);
  }
});

test("normalizeMap drops hotspots without files", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      { name: "missing files", files: [], risk: "high" },
      { name: "kept", files: ["src/app.ts"], risk: "low" },
    ],
  });

  assert.deepEqual(map.hotspots.map((hotspot) => hotspot.name), ["kept"]);
});

test("normalizeMap defaults invalid hotspot risk to med", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      { name: "risky", files: ["src/app.ts"], risk: "critical" },
    ],
  });

  assert.equal(map.hotspots[0]?.risk, "med");
});

test("normalizeMap drops edges missing consumerFile", () => {
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      {
        name: "edge case",
        files: ["src/app.ts"],
        edges: [
          { producer: "src/app.ts", why: "missing consumer file" },
          { producer: "src/app.ts", consumerFile: "src/ui.ts", why: "kept" },
        ],
      },
    ],
  });

  assert.deepEqual(map.hotspots[0]?.edges, [
    {
      producer: "src/app.ts",
      consumerFile: "src/ui.ts",
      consumerLine: 0,
      why: "kept",
    },
  ]);
});

test("normalizeMap truncates long hotspot names", () => {
  const longName = "x".repeat(100);
  const map = normalizeMap({
    summary: "reviewed",
    hotspots: [
      { name: longName, files: ["src/app.ts"] },
    ],
  });

  assert.equal(map.hotspots[0]?.name.length, 80);
  assert.equal(map.hotspots[0]?.name, "x".repeat(80));
});

test("normalizePrMeta accepts complete PR metadata", () => {
  const meta = normalizePrMeta({
    number: 12,
    title: "Fix parser",
    body: "Body text",
    comments: [" comment "],
    reviews: [{ body: " review " }],
    statusCheckRollup: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { context: "lint", status: "PENDING", conclusion: null },
    ],
  });

  assert.deepEqual(meta, {
    number: 12,
    title: "Fix parser",
    body: "Body text",
    comments: ["comment"],
    reviews: ["review"],
    checks: [
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "lint", status: "PENDING", conclusion: null },
    ],
  });
});

test("normalizePrMeta uses fallback number when number is missing", () => {
  const meta = normalizePrMeta({ title: "Fix parser" }, 12);

  assert.equal(meta.number, 12);
});

test("normalizePrMeta rejects missing number without fallback", () => {
  assert.throws(() => normalizePrMeta({ title: "Fix parser" }), /invalid number/);
});

test("normalizePrMeta rejects nonpositive or non-integer numbers", () => {
  for (const number of [0, -1, 1.5]) {
    assert.throws(() => normalizePrMeta({ number }), /invalid number/);
  }
});

test("normalizePrMeta drops non-object status checks", () => {
  const meta = normalizePrMeta({
    number: 12,
    statusCheckRollup: [
      "bad",
      { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
    ],
  });

  assert.deepEqual(meta.checks, [
    { name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
  ]);
});

test("normalizePrMeta turns non-string body into null", () => {
  for (const body of [null, 123]) {
    const meta = normalizePrMeta({ number: 12, body });

    assert.equal(meta.body, null);
  }
});

test("normalizePrMeta normalizes comments and reviews with bodyList behavior", () => {
  const meta = normalizePrMeta({
    number: 12,
    comments: [" first "],
    reviews: [{ body: " second " }],
  });

  assert.deepEqual(meta.comments, ["first"]);
  assert.deepEqual(meta.reviews, ["second"]);
});

test("normalizeBodyList trims strings and filters empty entries", () => {
  const bodies = normalizeBodyList([" first ", "", " ", "second"]);

  assert.deepEqual(bodies, ["first", "second"]);
});

test("normalizeBodyList accepts body-shaped objects", () => {
  const bodies = normalizeBodyList([{ body: " first " }, { body: " second " }]);

  assert.deepEqual(bodies, ["first", "second"]);
});

test("normalizeBodyList handles mixed string and body-shaped entries", () => {
  const bodies = normalizeBodyList([" first ", { body: " second " }, { body: "" }]);

  assert.deepEqual(bodies, ["first", "second"]);
});

test("normalizeBodyList returns empty array for non-array input", () => {
  for (const raw of [null, "string", {}]) {
    assert.deepEqual(normalizeBodyList(raw), []);
  }
});

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

test("normalizeFinding drops multiline replacement elements but keeps finding", () => {
  const raw = {
    severity: "P2",
    title: "Wrong branch",
    category: "bug",
    file: "src/app.ts",
    lineStart: 3,
    confidence: 0.9,
    whyItBreaks: "The branch returns the wrong value.",
    suggestedFix: "Replace the branch.",
    replacement: { lines: ["return ok;\nreturn wrong;"] },
  };

  const finding = normalizeFinding(raw);

  assert.equal(finding.title, "Wrong branch");
  assert.equal(finding.replacement, undefined);
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
  assert.throws(() => normalizeReview(raw, true), /malformed review output: residual risk text missing/);
  assert.throws(() => normalizeReview(raw, false), /malformed review output: residual risk text missing/);
});

function rawReview(residual_risks: unknown): Record<string, unknown> {
  return {
    summary: "s",
    findings: [],
    checked: ["x"],
    residual_risks,
  };
}

const NON_OBJECT_RESIDUAL_ENTRIES: readonly { readonly kind: string; readonly value: unknown }[] = [
  { kind: "string", value: "could not verify the changed path" },
  { kind: "number", value: 0 },
  { kind: "null", value: null },
  { kind: "boolean", value: false },
  { kind: "array", value: [{ text: "nested residual", blocks: true }] },
];

for (const { kind, value } of NON_OBJECT_RESIDUAL_ENTRIES) {
  test(`normalizeReview rejects ${kind} residual risk entry in both strict modes`, () => {
    const raw = rawReview([value]);
    const expected = /malformed review output: residual risk not an object/;
    assert.throws(() => normalizeReview(raw), expected);
    assert.throws(() => normalizeReview(raw, true), expected);
    assert.throws(() => normalizeReview(raw, false), expected);
  });
}

test("normalizeReview rejects boolean true residual risk entry in both strict modes", () => {
  const raw = rawReview([true]);
  const expected = /malformed review output: residual risk not an object/;
  assert.throws(() => normalizeReview(raw), expected);
  assert.throws(() => normalizeReview(raw, true), expected);
  assert.throws(() => normalizeReview(raw, false), expected);
});

test("normalizeReview rejects mixed valid residual object and bare string in both strict modes", () => {
  const raw = rawReview([
    { text: "local helper untraced", blocks: false },
    "could not verify the changed path",
  ]);
  const expected = /malformed review output: residual risk not an object/;
  assert.throws(() => normalizeReview(raw), expected);
  assert.throws(() => normalizeReview(raw, true), expected);
  assert.throws(() => normalizeReview(raw, false), expected);
});

test("normalizeReview round-trips blocking residual risk to needs_human in both strict modes", () => {
  const residual = { text: "could not verify the changed path", blocks: true };
  for (const strict of [true, false] as const) {
    const review = normalizeReview(rawReview([residual]), strict);
    assert.deepEqual(review.residual_risks, [residual]);
    assert.equal(deriveVerdict(review.findings, review.residual_risks), "needs_human");
  }
  const defaultReview = normalizeReview(rawReview([residual]));
  assert.deepEqual(defaultReview.residual_risks, [residual]);
  assert.equal(deriveVerdict(defaultReview.findings, defaultReview.residual_risks), "needs_human");
});

test("normalizeReview round-trips non-blocking residual risk to pass in both strict modes", () => {
  const residual = { text: "low confidence private helper", blocks: false };
  for (const strict of [true, false] as const) {
    const review = normalizeReview(rawReview([residual]), strict);
    assert.deepEqual(review.residual_risks, [residual]);
    assert.equal(deriveVerdict(review.findings, review.residual_risks), "pass");
  }
  const defaultReview = normalizeReview(rawReview([residual]));
  assert.deepEqual(defaultReview.residual_risks, [residual]);
  assert.equal(deriveVerdict(defaultReview.findings, defaultReview.residual_risks), "pass");
});

test("normalizeReview accepts empty residual_risks in both strict modes", () => {
  for (const strict of [true, false] as const) {
    const review = normalizeReview(rawReview([]), strict);
    assert.deepEqual(review.residual_risks, []);
    assert.equal(deriveVerdict(review.findings, review.residual_risks), "pass");
  }
  const defaultReview = normalizeReview(rawReview([]));
  assert.deepEqual(defaultReview.residual_risks, []);
  assert.equal(deriveVerdict(defaultReview.findings, defaultReview.residual_risks), "pass");
});

test("normalizeReview loose mode still rejects malformed residuals after dropping malformed findings", () => {
  const raw = {
    summary: "s",
    findings: [{ severity: "bad" }],
    checked: ["x"],
    residual_risks: ["could not verify the changed path"],
  };

  assert.throws(
    () => normalizeReview(raw, false),
    /malformed review output: residual risk not an object/,
  );
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
