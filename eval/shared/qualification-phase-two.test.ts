import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Finding } from "../../src/shared/schema";
import { score, drawFindings } from "./score";
import { evaluatePhaseTwoQualification, type PhaseTwoQualificationPolicy } from "./qualification";
import { fixtureSetSha256 } from "./fixture-catalog";
import { phaseTwoOracleIdentity } from "./quality-oracle";
import type { DrawResult, FixtureSpec, Report } from "./types";

const finding: Finding = {
  severity: "P1", category: "bug", file: "guard.ts", lineStart: 2, lineEnd: 2,
  title: "guard bypass", whyItBreaks: "unauthorized requests pass", confidence: 1,
  suggestedFix: "restore guard", validation: "reject unauthorized request",
};

function fixture(id: string, tier: 1 | 2 | 3 = 1, family = "authorization"): FixtureSpec {
  return {
    id, kind: "positive", tier, defectClass: family, description: "guard removed",
    baseFiles: { "guard.ts": "check();\n" }, headFiles: { "guard.ts": "allow();\n" },
    expected: { verdict: "changes_requested", mustFind: [{ pattern: "guard", file: "guard.ts" }], anchorLineRange: [2, 2] },
  };
}

const specs: readonly FixtureSpec[] = [
  ...Array.from({ length: 15 }, (_, index) => fixture(`t1-${index}`, 1, `family-${index % 7}`)),
  fixture("t2", 2, "family-0"),
  fixture("t3", 3, "family-0"),
  { ...fixture("negative"), kind: "negative", tier: undefined, expected: { verdict: "pass", noBlockingFindings: true } },
];

const policy: PhaseTwoQualificationPolicy = {
  id: "test-phase-two", broadDraws: 3, deepDraws: 6, consistencyK: 3,
  floors: {
    minNoisePerPositive: null, minTierOneAggregate: null, minTierOnePerFixture: null,
    minTierOneFamilyRecall: null, minTierOneFamilyLocalization: null,
    minActionablePrecision: null, maxNegativeFalsePositiveDrawRate: null,
    minSeverityCalibration: null, minSeverityLabelCoverage: null, minObservedPassK: null,
  },
};

function draw(spec: FixtureSpec, index: number, findings: readonly Finding[]): DrawResult {
  return {
    fixtureId: spec.id, draw: index, durationMs: 1, calls: 2, retries: 0,
    findings: drawFindings(findings), score: score({ verdict: findings.length ? "changes_requested" : "pass", findings }, spec.expected, spec.id),
  };
}

function report(
  selected: readonly FixtureSpec[],
  draws: number,
  outcomes: (spec: FixtureSpec, index: number) => readonly Finding[] = (spec) => spec.kind === "positive" ? [finding] : [],
): Report {
  return {
    promptHash: "frozen", runner: "codex", model: "test", effort: "high", draws,
    createdAt: "2026-10-16T00:00:00Z", baseline: false, holdout: "include", gateClass: "R",
    fixtures: selected.map((spec) => spec.id),
    results: selected.flatMap((spec) => Array.from({ length: draws }, (_, index) => draw(spec, index, outcomes(spec, index)))),
    aggregates: {
      recall: 1, falsePositiveRate: 0, invalidJsonRate: 0, verdictMatchRate: 1,
      lineAnchorValidRate: 1, meanDurationMs: 1, recallByFixture: {},
      criticPruneErrorRate: 0, recallByTier: {}, meanNoisePerPositive: 0,
      cheatDetectedCount: 0, baitExposureCount: 0, criticPrunedRecallCount: 0,
    },
  };
}

function campaign(selected = specs) {
  return {
    broad: report(selected, 3),
    deep: report(selected.filter((spec) => spec.kind === "positive" && spec.tier === 1), 6),
  };
}

test("Phase 2 admits complete distinct coverage but refuses unset floors and unknown quality labels", () => {
  const result = evaluatePhaseTwoQualification(campaign(), specs, policy);
  assert.equal(result.eligible, false);
  assert.deepEqual(result.tierOne, {
    hits: 90, total: 90, perFixture: Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`t1-${index}`, 1])),
  });
  assert.equal(result.reasons.filter((reason) => reason.startsWith("unset floor:")).length, 10);
  assert.deepEqual(result.actionablePrecision, { status: "unknown", reason: "independent actionable TP/FP adjudication is absent" });
  assert.deepEqual(result.severityCalibration, { status: "unknown", reason: "gold severity labels are absent" });
  const configuredResult = evaluatePhaseTwoQualification(campaign(), specs, {
    ...policy, floors: {
      minNoisePerPositive: 0, minTierOneAggregate: 0, minTierOnePerFixture: 0,
      minTierOneFamilyRecall: 0, minTierOneFamilyLocalization: 0, minActionablePrecision: 0,
      maxNegativeFalsePositiveDrawRate: 0, minSeverityCalibration: 0, minSeverityLabelCoverage: 0, minObservedPassK: 0,
    },
  });
  assert.deepEqual(configuredResult.reasons, [
    "unknown required metric: minActionablePrecision (independent actionable TP/FP adjudication is absent)",
    "unknown required metric: minSeverityCalibration (gold severity labels are absent)",
    "unknown required metric: minSeverityLabelCoverage (gold severity labels are absent)",
  ]);
});

test("Phase 2 rejects missing, duplicate, foreign, noninteger, and out-of-range slots in either campaign", () => {
  const valid = campaign();
  for (const name of ["broad", "deep"] as const) {
    const source = valid[name];
    for (const results of [
      source.results.slice(1),
      [...source.results, source.results[0]],
      source.results.map((result, index) => index === 0 ? { ...result, fixtureId: "foreign" } : result),
      source.results.map((result, index) => index === 0 ? { ...result, draw: 0.5 } : result),
      source.results.map((result, index) => index === 0 ? { ...result, draw: -1 } : result),
      source.results.map((result, index) => index === 0 ? { ...result, draw: source.draws } : result),
      source.results.map((result, index) => index === 0 ? source.results[1] : result),
    ]) assert.throws(() => evaluatePhaseTwoQualification({ ...valid, [name]: { ...source, results } }, specs, policy), /exactly one result/);
  }
  assert.throws(() => evaluatePhaseTwoQualification(valid, [...specs, specs[0]], policy), /exactly one result/);
  assert.throws(() => evaluatePhaseTwoQualification(valid, specs, { ...policy, consistencyK: 7 }), /consistency k/);
});

test("Phase 2 Tier-1 family gates exclude lower tiers and report them separately", () => {
  const valid = campaign();
  const broad = report(specs, 3, (spec) => spec.tier === 1 ? [finding] : []);
  const result = evaluatePhaseTwoQualification({ ...valid, broad }, specs, policy);
  assert.deepEqual(result.recallByTierOneFamily["family-0"], { status: "measured", value: 1, numerator: 18, denominator: 18 });
  assert.deepEqual(result.broadRecallByFamilyDiagnostic["family-0"], { status: "measured", value: 3 / 5, numerator: 9, denominator: 15 });
});

test("Phase 2 missing line or file oracle is unknown even when legacy score says localized", () => {
  const noLine = specs.map((spec) => spec.id === "t1-0" ? { ...spec, expected: { ...spec.expected, anchorLineRange: undefined } } : spec);
  const result = evaluatePhaseTwoQualification(campaign(noLine), noLine, policy);
  assert.deepEqual(result.localizationByTierOneFamily["family-0"], { status: "unknown", reason: "missing file or line oracle" });
  const noFile = specs.map((spec) => spec.id === "t1-0" ? { ...spec, expected: { ...spec.expected, mustFind: [{ pattern: "guard" }] } } : spec);
  const missing = evaluatePhaseTwoQualification(campaign(noFile), noFile, policy);
  assert.deepEqual(missing.requiredGoldMatchPrecisionProxy.micro, { status: "unknown", reason: "missing findings or file oracle" });
  const absent = campaign(noFile);
  const abstention = evaluatePhaseTwoQualification({ ...absent, broad: report(noFile, 3, () => []) }, noFile, policy);
  assert.equal(abstention.requiredGoldMatchPrecisionProxy.abstentionDraws, 54);
  assert.deepEqual(abstention.requiredGoldMatchPrecisionProxy.micro, { status: "unknown", reason: "missing findings or file oracle" });
});

test("Phase 2 precision proxy uses one-to-one maximal anchored matches and includes negative emissions", () => {
  const multi = [fixture("multi"), { ...fixture("negative"), kind: "negative" as const, tier: undefined, expected: { verdict: "pass" as const, noBlockingFindings: true } }];
  const positive = multi[0];
  const selected = [{ ...positive, expected: { ...positive.expected, mustFind: [{ pattern: "guard", file: "guard.ts" }, { pattern: "bypass", file: "guard.ts" }] } }, multi[1]];
  const source = campaign(selected);
  const one = evaluatePhaseTwoQualification(source, selected, policy);
  assert.deepEqual(one.requiredGoldMatchPrecisionProxy.micro, { status: "measured", value: 1, numerator: 3, denominator: 3 });
  assert.deepEqual(one.localizationByTierOneFamily.authorization, { status: "measured", value: 0, numerator: 0, denominator: 6 });
  const broad = report(selected, 3, (spec) => spec.kind === "negative" ? [finding] : [finding, { ...finding, title: "guard", whyItBreaks: "guard removed" }]);
  const result = evaluatePhaseTwoQualification({ ...source, broad }, selected, policy);
  assert.deepEqual(result.requiredGoldMatchPrecisionProxy.micro, { status: "measured", value: 2 / 3, numerator: 6, denominator: 9 });
  assert.deepEqual(result.requiredGoldMatchPrecisionProxy.meanPerEmittingReview, { status: "measured", value: 0.5, numerator: 3, denominator: 6 });
  assert.deepEqual(result.negativeFalsePositiveDrawRate, { status: "measured", value: 1, numerator: 3, denominator: 3 });
  const wrongFile = report(selected, 3, () => [{ ...finding, file: "wrong.ts" }]);
  assert.deepEqual(evaluatePhaseTwoQualification({ ...source, broad: wrongFile }, selected, policy).requiredGoldMatchPrecisionProxy.micro,
    { status: "measured", value: 0, numerator: 0, denominator: 6 });
});

test("Phase 2 abstention has unknown precision and observed pass^k averages fixture subsets", () => {
  const valid = campaign();
  const broad = report(specs, 3, () => []);
  const result = evaluatePhaseTwoQualification({ ...valid, broad }, specs, policy);
  assert.deepEqual(result.requiredGoldMatchPrecisionProxy.micro, { status: "unknown", reason: "no observations" });
  assert.equal(result.requiredGoldMatchPrecisionProxy.abstentionDraws, 54);
  const selected = [fixture("all"), fixture("half")];
  const deep = report(selected, 6, (spec, index) => spec.id === "all" || index < 3 ? [finding] : []);
  const consistency = evaluatePhaseTwoQualification({ broad: report(selected, 3), deep }, selected, policy).observedPassK;
  assert.deepEqual(consistency, { k: 3, fixtureWeighted: { status: "measured", value: 0.525, numerator: 1.05, denominator: 2 } });
});

test("Phase 2 enforces measured floors and never counts missing findings or wrong lines as localized", () => {
  const valid = campaign();
  const deep = report(specs.filter((spec) => spec.tier === 1), 6, (spec) => spec.defectClass === "family-0" ? [] : [{ ...finding, lineStart: 3, lineEnd: 3 }]);
  const result = evaluatePhaseTwoQualification({ ...valid, deep }, specs, {
    ...policy, floors: { ...policy.floors, minTierOneFamilyRecall: 0.5, minTierOneFamilyLocalization: 0.5 },
  });
  assert.deepEqual(result.recallByTierOneFamily["family-0"], { status: "measured", value: 0, numerator: 0, denominator: 18 });
  assert.deepEqual(result.localizationByTierOneFamily["family-1"], { status: "measured", value: 0, numerator: 0, denominator: 12 });
  assert.equal(result.reasons.includes("failed floor: minTierOneFamilyRecall"), true);
  assert.equal(result.reasons.includes("failed floor: minTierOneFamilyLocalization"), true);
  const missing = { ...valid.deep, results: valid.deep.results.map((draw, index) => index === 0 ? { ...draw, findings: undefined } : draw) };
  assert.deepEqual(evaluatePhaseTwoQualification({ ...valid, deep: missing }, specs, policy).localizationByTierOneFamily["family-0"], { status: "unknown", reason: "missing findings" });
  assert.throws(() => evaluatePhaseTwoQualification(valid, specs, { ...policy, floors: { ...policy.floors, minTierOneAggregate: NaN } }), /invalid Phase 2 floor/);
  assert.throws(() => evaluatePhaseTwoQualification({ ...valid, broad: { ...valid.broad, draws: 6 } }, specs, policy), /exactly one result/);
  const corrupt = { ...valid.deep, results: valid.deep.results.map((draw, index) => index === 0 ? { ...draw, score: { ...draw.score, formatOk: false } } : draw) };
  assert.equal(evaluatePhaseTwoQualification({ ...valid, deep: corrupt }, specs, policy).reasons.includes("invalid or compromised draw"), true);
});

function independentOracle(source: ReturnType<typeof campaign>) {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    schemaVersion: 1,
    identity: { broadSha256: digest(source.broad), deepSha256: digest(source.deep), fixtureSetSha256: fixtureSetSha256(specs) },
    adjudication: {
      author: "independent-reviewer", provenance: "synthetic blind source review",
      rows: source.broad.results.flatMap((result) => (result.findings ?? []).map((_, findingIndex) => ({
        fixtureId: result.fixtureId, draw: result.draw, findingIndex, decision: "actionable", defectId: "guard-defect",
      }))),
    },
    severityGold: {
      author: "independent-gold-author", provenance: "synthetic predeclared defect labels",
      frozenAt: "2026-10-15T00:00:00Z",
      labels: specs.filter((spec) => spec.kind === "positive").map((spec) => ({ fixtureId: spec.id, defectId: "guard-defect", acceptedSeverities: ["P1"] })),
    },
  };
}

test("Phase 2 independent oracle measures actual TP/FP and severity predictions without gold proxies", () => {
  const source = campaign();
  const result = evaluatePhaseTwoQualification(source, specs, policy, independentOracle(source));
  assert.deepEqual(result.actionablePrecision, { status: "measured", value: 1, numerator: 51, denominator: 51 });
  assert.deepEqual(result.severityCalibration, { status: "measured", value: 1, numerator: 51, denominator: 51 });
});


const configuredPolicy: PhaseTwoQualificationPolicy = {
  ...policy,
  floors: {
    minNoisePerPositive: 0, minTierOneAggregate: 1, minTierOnePerFixture: 1,
    minTierOneFamilyRecall: 1, minTierOneFamilyLocalization: 1, minActionablePrecision: 1,
    maxNegativeFalsePositiveDrawRate: 0, minSeverityCalibration: 1, minSeverityLabelCoverage: 1, minObservedPassK: 1,
  },
};

test("Phase 2 oracle includes negative false positives and independently adjudicated sibling defects", () => {
  const source = { ...campaign(), broad: report(specs, 3, (spec, index) => {
    if (spec.kind === "negative") return index === 0 ? [{ ...finding, severity: "P0" }] : [];
    return spec.id === "t1-0" && index === 0
      ? [finding, { ...finding, severity: "P2", title: "sibling defect", whyItBreaks: "different defect" }]
      : [finding];
  }) };
  const oracle = independentOracle(source);
  const rows = oracle.adjudication.rows.map((row) => row.fixtureId === "negative"
    ? { fixtureId: row.fixtureId, draw: row.draw, findingIndex: row.findingIndex, decision: "false_positive" }
    : { ...row, defectId: row.findingIndex === 1 ? "sibling" : row.defectId });
  const result = evaluatePhaseTwoQualification(source, specs, configuredPolicy, {
    ...oracle, adjudication: { ...oracle.adjudication, rows },
  });
  assert.deepEqual(result.actionablePrecision, { status: "measured", value: 52 / 53, numerator: 52, denominator: 53 });
  assert.deepEqual(result.severityCalibration, { status: "measured", value: 1, numerator: 51, denominator: 51 });
  assert.deepEqual(result.severityLabelCoverage, { status: "measured", value: 51 / 52, numerator: 51, denominator: 52 });
  assert.deepEqual(result.requiredGoldMatchPrecisionProxy.micro, { status: "measured", value: 51 / 53, numerator: 51, denominator: 53 });
  assert.equal(result.eligible, false);
  assert.equal(result.reasons.includes("failed floor: minActionablePrecision"), true);
  assert.equal(result.reasons.includes("failed floor: minSeverityLabelCoverage"), true);
});

test("Phase 2 independent labels allow complete synthetic qualification without selecting production floors", () => {
  const source = campaign();
  const result = evaluatePhaseTwoQualification(source, specs, configuredPolicy, independentOracle(source));
  assert.equal(result.eligible, true);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(phaseTwoOracleIdentity(source, specs), independentOracle(source).identity);
  assert.equal(evaluatePhaseTwoQualification(source, specs, policy, independentOracle(source)).eligible, false);
});

test("Phase 2 partial or unresolved adjudication cannot qualify even with zero quality floors", () => {
  const source = campaign();
  const oracle = independentOracle(source);
  const zeroQuality = { ...configuredPolicy, floors: { ...configuredPolicy.floors, minActionablePrecision: 0, minSeverityCalibration: 0 } };
  for (const rows of [
    [], oracle.adjudication.rows.slice(1),
    oracle.adjudication.rows.map((row, index) => index === 0
      ? { fixtureId: row.fixtureId, draw: row.draw, findingIndex: row.findingIndex, decision: "unresolved", reason: "source evidence insufficient" }
      : row),
  ]) {
    const result = evaluatePhaseTwoQualification(source, specs, zeroQuality, { ...oracle, adjudication: { ...oracle.adjudication, rows } });
    assert.deepEqual(result.actionablePrecision, { status: "unknown", reason: "missing or unresolved independent finding adjudication" });
    assert.deepEqual(result.severityCalibration, { status: "unknown", reason: "missing or unresolved independent finding adjudication" });
    assert.deepEqual(result.severityLabelCoverage, { status: "unknown", reason: "missing or unresolved independent finding adjudication" });
    assert.equal(result.eligible, false);
  }
});

test("Phase 2 missing gold preserves actionable precision but cannot infer severity from predictions", () => {
  const source = campaign();
  const oracle = independentOracle(source);
  for (const severityGold of [null, { ...oracle.severityGold, labels: [] }]) {
    const result = evaluatePhaseTwoQualification(source, specs, configuredPolicy, { ...oracle, severityGold });
    assert.deepEqual(result.actionablePrecision, { status: "measured", value: 1, numerator: 51, denominator: 51 });
    assert.deepEqual(result.severityCalibration, { status: "unknown", reason: "no independently labeled actionable findings" });
    assert.deepEqual(result.severityLabelCoverage, { status: "measured", value: 0, numerator: 0, denominator: 51 });
    assert.equal(result.eligible, false);
  }
  const downgraded = { ...source, broad: report(specs, 3, (spec) => spec.kind === "positive" ? [{ ...finding, severity: "P3" }] : []) };
  const result = evaluatePhaseTwoQualification(downgraded, specs, configuredPolicy, independentOracle(downgraded));
  assert.deepEqual(result.actionablePrecision, { status: "measured", value: 1, numerator: 51, denominator: 51 });
  assert.deepEqual(result.severityCalibration, { status: "measured", value: 0, numerator: 0, denominator: 51 });
  assert.equal(result.eligible, false);
});

test("Phase 2 oracle abstention and all false positives never supply perfect severity samples", () => {
  const source = { ...campaign(), broad: report(specs, 3, () => []) };
  const empty = evaluatePhaseTwoQualification(source, specs, configuredPolicy, independentOracle(source));
  assert.deepEqual(empty.actionablePrecision, { status: "unknown", reason: "no emitted findings" });
  assert.deepEqual(empty.severityCalibration, { status: "unknown", reason: "no actionable findings" });
  assert.equal(empty.eligible, false);
  const emitting = campaign();
  const oracle = independentOracle(emitting);
  const falsePositive = evaluatePhaseTwoQualification(emitting, specs, configuredPolicy, {
    ...oracle, adjudication: { ...oracle.adjudication, rows: oracle.adjudication.rows.map((row) => ({
      fixtureId: row.fixtureId, draw: row.draw, findingIndex: row.findingIndex, decision: "false_positive",
    })) },
  });
  assert.deepEqual(falsePositive.actionablePrecision, { status: "measured", value: 0, numerator: 0, denominator: 51 });
  assert.deepEqual(falsePositive.severityCalibration, { status: "unknown", reason: "no actionable findings" });
  assert.equal(falsePositive.eligible, false);
});

test("Phase 2 rejects malformed, duplicate, foreign, wrong-report and out-of-range oracle identities", () => {
  const source = campaign();
  const oracle = independentOracle(source);
  const first = oracle.adjudication.rows[0];
  const rowInputs = [
    [...oracle.adjudication.rows, first],
    [{ ...first, fixtureId: "foreign" }], [{ ...first, draw: -1 }], [{ ...first, draw: 0.5 }],
    [{ ...first, draw: 3 }], [{ ...first, findingIndex: 1 }], [{ ...first, findingIndex: -1 }],
    [{ ...first, decision: "model_matched" }], [{ ...first, decision: "unresolved" }],
    [{ ...first, prediction: "P1" }],
  ];
  for (const rows of rowInputs) assert.throws(() => evaluatePhaseTwoQualification(source, specs, configuredPolicy, {
    ...oracle, adjudication: { ...oracle.adjudication, rows },
  }), /Phase 2 quality oracle/);
  for (const key of ["broadSha256", "deepSha256", "fixtureSetSha256"] as const) {
    assert.throws(() => evaluatePhaseTwoQualification(source, specs, configuredPolicy, {
      ...oracle, identity: { ...oracle.identity, [key]: "0".repeat(64) },
    }), /identity mismatch/);
  }
  for (const bad of [null, {}, { ...oracle, schemaVersion: 2 }, { ...oracle, adjudication: { ...oracle.adjudication, author: " " } }]) {
    assert.throws(() => evaluatePhaseTwoQualification(source, specs, configuredPolicy, bad), /invalid Phase 2 quality oracle/);
  }
  const changed = { ...source, broad: { ...source.broad, model: "different-model" } };
  assert.throws(() => evaluatePhaseTwoQualification(changed, specs, configuredPolicy, oracle), /identity mismatch/);
  const changedFinding = { ...source, broad: report(specs, 3, (spec) => spec.kind === "positive" ? [{ ...finding, title: "changed" }] : []) };
  assert.throws(() => evaluatePhaseTwoQualification(changedFinding, specs, configuredPolicy, oracle), /identity mismatch/);
});

test("Phase 2 rejects duplicate or foreign severity gold and labels frozen after reports", () => {
  const source = campaign();
  const oracle = independentOracle(source);
  for (const labels of [
    [...oracle.severityGold.labels, oracle.severityGold.labels[0]],
    [{ ...oracle.severityGold.labels[0], fixtureId: "foreign" }],
    [{ ...oracle.severityGold.labels[0], acceptedSeverities: [] }],
    [{ ...oracle.severityGold.labels[0], acceptedSeverities: ["P4"] }],
  ]) assert.throws(() => evaluatePhaseTwoQualification(source, specs, configuredPolicy, {
    ...oracle, severityGold: { ...oracle.severityGold, labels },
  }), /Phase 2 (?:gold|quality oracle)/);
  for (const frozenAt of ["2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z", "2026-02-30T00:00:00Z", "invalid"]) {
    assert.throws(() => evaluatePhaseTwoQualification(source, specs, configuredPolicy, {
      ...oracle, severityGold: { ...oracle.severityGold, frozenAt },
    }), /Phase 2 (?:gold|quality oracle)/);
  }
});

test("Phase 2 refuses duplicate actionable defects and missing finding artifacts", () => {
  const source = { ...campaign(), broad: report(specs, 3, (spec) => spec.kind === "positive" ? [finding, finding] : []) };
  assert.throws(() => evaluatePhaseTwoQualification(source, specs, configuredPolicy, independentOracle(source)), /duplicate actionable defect/);
  const valid = campaign();
  const missing = { ...valid, broad: { ...valid.broad, results: valid.broad.results.map((draw, index) => index === 0 ? { ...draw, findings: undefined } : draw) } };
  const result = evaluatePhaseTwoQualification(missing, specs, configuredPolicy, independentOracle(missing));
  assert.deepEqual(result.actionablePrecision, { status: "unknown", reason: "missing or unresolved independent finding adjudication" });
  assert.equal(result.eligible, false);
});

test("Phase 2 independent oracle cannot override compromised reports or promote proxy-only truth", () => {
  const source = campaign();
  for (const scoreChange of [{ formatOk: false }, { cheatDetected: true }]) {
    const corrupt = { ...source, broad: { ...source.broad, results: source.broad.results.map((draw, index) => index === 0
      ? { ...draw, score: { ...draw.score, ...scoreChange } } : draw) } };
    const result = evaluatePhaseTwoQualification(corrupt, specs, configuredPolicy, independentOracle(corrupt));
    assert.deepEqual(result.actionablePrecision, { status: "measured", value: 1, numerator: 51, denominator: 51 });
    assert.equal(result.eligible, false);
    assert.equal(result.reasons.includes("invalid or compromised draw"), true);
  }
  const siblingSpecs = specs.map((spec) => ({ ...spec, expected: { ...spec.expected, mayFind: [{ pattern: "guard", file: "guard.ts" }] } }));
  const proxyOnly = evaluatePhaseTwoQualification(campaign(siblingSpecs), siblingSpecs, configuredPolicy);
  assert.deepEqual(proxyOnly.actionablePrecision, { status: "unknown", reason: "independent actionable TP/FP adjudication is absent" });
  assert.deepEqual(proxyOnly.severityCalibration, { status: "unknown", reason: "gold severity labels are absent" });
  assert.equal(proxyOnly.eligible, false);
  assert.throws(() => evaluatePhaseTwoQualification(source, siblingSpecs, configuredPolicy, independentOracle(source)), /fixtureSetSha256/);
});


test("Phase 2 omitted floors stay unset even when an oracle measures all quality metrics", () => {
  const source = campaign();
  for (const key of Object.keys(configuredPolicy.floors)) {
    for (const mode of ["omitted", "undefined"] as const) {
      const floors = { ...configuredPolicy.floors };
      if (mode === "omitted") Reflect.deleteProperty(floors, key);
      else Reflect.set(floors, key, undefined);
      const result = evaluatePhaseTwoQualification(source, specs, { ...configuredPolicy, floors }, independentOracle(source));
      assert.equal(result.eligible, false, `${key} ${mode}`);
      assert.equal(result.reasons.includes(`unset floor: ${key}`), true, `${key} ${mode}`);
    }
  }
});


test("Phase 2 partial severity labels measure calibration and independently gate label coverage", () => {
  const source = campaign();
  const oracle = independentOracle(source);
  const partial = { ...oracle, severityGold: { ...oracle.severityGold, labels: oracle.severityGold.labels.slice(1) } };
  const result = evaluatePhaseTwoQualification(source, specs, configuredPolicy, partial);
  assert.deepEqual(result.severityCalibration, { status: "measured", value: 1, numerator: 48, denominator: 48 });
  assert.deepEqual(result.severityLabelCoverage, { status: "measured", value: 48 / 51, numerator: 48, denominator: 51 });
  assert.deepEqual(result.reasons, ["failed floor: minSeverityLabelCoverage"]);
  const testOnlyRelaxed = { ...configuredPolicy, floors: { ...configuredPolicy.floors, minSeverityLabelCoverage: 0.9 } };
  assert.equal(evaluatePhaseTwoQualification(source, specs, testOnlyRelaxed, partial).eligible, true);
});

test("Phase 2 a newly discovered sibling needs no invented pre-run severity gold", () => {
  const source = { ...campaign(), broad: report(specs, 3, (spec, index) => spec.kind === "negative" ? []
    : spec.id === "t1-0" && index === 0 ? [finding, { ...finding, severity: "P3", title: "new sibling" }] : [finding]) };
  const oracle = independentOracle(source);
  const independent = { ...oracle, adjudication: { ...oracle.adjudication, rows: oracle.adjudication.rows.map((row) =>
    row.findingIndex === 1 ? { ...row, defectId: "new-sibling" } : row) } };
  const result = evaluatePhaseTwoQualification(source, specs, configuredPolicy, independent);
  assert.deepEqual(result.actionablePrecision, { status: "measured", value: 1, numerator: 52, denominator: 52 });
  assert.deepEqual(result.severityCalibration, { status: "measured", value: 1, numerator: 51, denominator: 51 });
  assert.deepEqual(result.severityLabelCoverage, { status: "measured", value: 51 / 52, numerator: 51, denominator: 52 });
  assert.deepEqual(result.reasons, ["failed floor: minSeverityLabelCoverage"]);
  const testOnlyRelaxed = { ...configuredPolicy, floors: { ...configuredPolicy.floors, minSeverityLabelCoverage: 0.9 } };
  assert.equal(evaluatePhaseTwoQualification(source, specs, testOnlyRelaxed, independent).eligible, true);
});

test("Phase 2 canonical fixture identity survives catalog order and display metadata changes", () => {
  const source = campaign();
  const oracle = independentOracle(source);
  const reordered = [...specs].reverse().map((spec) => ({ ...spec, description: "other display text" }));
  assert.deepEqual(phaseTwoOracleIdentity(source, reordered), oracle.identity);
  assert.equal(evaluatePhaseTwoQualification(source, reordered, configuredPolicy, oracle).eligible, true);
  const changed = specs.map((spec, index) => index === 0 ? { ...spec, headFiles: { "guard.ts": "changed();\n" } } : spec);
  assert.throws(() => evaluatePhaseTwoQualification(source, changed, configuredPolicy, oracle), /fixtureSetSha256/);
});

test("Phase 2 independent actionable negatives retain legacy scores and block contradictory truth", () => {
  const source = { ...campaign(), broad: report(specs, 3, (spec, index) => spec.kind === "positive" || index === 0 ? [finding] : []) };
  const before = JSON.stringify(source);
  const oracle = independentOracle(source);
  const permissive = { ...configuredPolicy, floors: { ...configuredPolicy.floors, maxNegativeFalsePositiveDrawRate: 1, minSeverityLabelCoverage: 0 } };
  const result = evaluatePhaseTwoQualification(source, specs, permissive, oracle);
  assert.deepEqual(result.actionablePrecision, { status: "measured", value: 1, numerator: 52, denominator: 52 });
  assert.deepEqual(result.negativeFalsePositiveDrawRate, { status: "measured", value: 1 / 3, numerator: 1, denominator: 3 });
  assert.deepEqual(result.reasons, ["independent actionable finding conflicts with negative false-positive proxy: negative draw 0"]);
  assert.equal(result.eligible, false);
  assert.equal(JSON.stringify(source), before);
});
