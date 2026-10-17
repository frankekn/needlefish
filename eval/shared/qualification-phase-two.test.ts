import assert from "node:assert/strict";
import test from "node:test";
import type { Finding } from "../../src/shared/schema";
import { score, drawFindings } from "./score";
import { evaluatePhaseTwoQualification, type PhaseTwoQualificationPolicy } from "./qualification";
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
    minSeverityCalibration: null, minObservedPassK: null,
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
  assert.equal(result.reasons.filter((reason) => reason.startsWith("unset floor:")).length, 9);
  assert.deepEqual(result.actionablePrecision, { status: "unknown", reason: "independent actionable TP/FP adjudication is absent" });
  assert.deepEqual(result.severityCalibration, { status: "unknown", reason: "gold severity labels are absent" });
  const configuredResult = evaluatePhaseTwoQualification(campaign(), specs, {
    ...policy, floors: {
      minNoisePerPositive: 0, minTierOneAggregate: 0, minTierOnePerFixture: 0,
      minTierOneFamilyRecall: 0, minTierOneFamilyLocalization: 0, minActionablePrecision: 0,
      maxNegativeFalsePositiveDrawRate: 0, minSeverityCalibration: 0, minObservedPassK: 0,
    },
  });
  assert.deepEqual(configuredResult.reasons, [
    "unknown required metric: minActionablePrecision (independent actionable TP/FP adjudication is absent)",
    "unknown required metric: minSeverityCalibration (gold severity labels are absent)",
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
