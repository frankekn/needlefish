import Ajv from "ajv";
import { isDeepStrictEqual } from "node:util";
import { matchEvidence } from "./score";
import { RUNNERS } from "../../src/shared/runner";
import { comparisonEnvironmentError, runnerEnvironmentAttestationError } from "../../src/shared/runner-attestation";
import { fixtureClassifications, validateStoredScore } from "../gen-site";
import { fixtureSetHash } from "./fixture-catalog";
import { promptHash } from "./prompt-hash";
import { PHASE_TWO_FLOORS, type PhaseTwoQualificationPolicy } from "./qualification";
import { hasConsistentCheatDetection, hasCurrentScorer } from "./report-integrity";
import { isCompleteReport } from "./report-completeness";
import { operationalFailures, sameRecord, type PublishedReport } from "./publication";
import { ANTICHEAT_VERSION, type DrawFinding, type FixtureSpec } from "./types";

export type PhaseTwoReport = Omit<PublishedReport, "results"> & {
  readonly results: readonly (PublishedReport["results"][number] & { readonly candidateFindings?: readonly DrawFinding[] })[];
  readonly fixtureDefectClasses?: Readonly<Record<string, string>>;
  readonly aggregates: PublishedReport["aggregates"] & {
    readonly recallByDefectClass?: Readonly<Record<string, number>>;
    readonly lineAnchorValidRateByDefectClass?: Readonly<Record<string, number>>;
  };
};

const text = { type: "string", minLength: 1, pattern: "\\S" };
const count = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const positive = { ...count, minimum: 1 };
const nonnegative = { type: "number", minimum: 0 };
const rate = { type: "number", minimum: 0, maximum: 1 };
const boolean = { type: "boolean" };
const verdict = { enum: ["pass", "changes_requested", "needs_human"] };
const severity = { enum: ["P0", "P1", "P2", "P3"] };
const category = { enum: ["bug", "contract", "duplicate", "runtime", "security", "validation"] };
function object(properties: Record<string, unknown>, required = Object.keys(properties), additionalProperties = true) {
  return { type: "object", required, properties, additionalProperties };
}
function recordOf(items: unknown) { return { type: "object", additionalProperties: items }; }
const rateRecord = recordOf(rate);
const lineRange = { type: "array", minItems: 2, maxItems: 2, items: positive };
const match = {
  pattern: text, category, file: text, lineRange,
  facts: { type: "array", items: object({ id: text, meaning: text, alternatives: {
    type: "array", items: object({ allOf: { type: "array", items: text } }),
  } }) },
  findingIndex: { anyOf: [count, { type: "null" }] },
};
const evidence = { type: "array", items: object(match, ["findingIndex"]) };
const findings = { type: "array", items: object({ severity, category, file: text, lineStart: positive, lineEnd: positive, title: text, whyItBreaks: text }) };
const robustness = object({
  rawExposure: boolean, rawExposureCount: count, candidateAdoption: boolean, candidateAdoptionCount: count,
  criticRecovery: boolean, finalReviewTextMarkerLeak: boolean, finalReviewTextMarkerLeakCount: count,
  finalFindingMarkerEscape: boolean, finalFindingMarkerEscapeCount: count, totalMatchedEventCount: count,
  missingProvenanceCount: count,
  matchProvenance: { type: "array", items: object({
    detectorKind: { enum: ["canary", "trap"] },
    surface: { enum: ["raw_success", "raw_failure", "candidate_finding", "candidate_review_text", "final_finding", "final_review_text"] },
    passKind: { enum: ["review", "map", "deep", "critic"] }, passIndex: count, promptAttempt: positive, runnerAttempt: positive,
    outcome: { enum: ["parsed", "parse_failed", "runner_failed"] },
  }) },
});
const scoreFields = {
  fixtureId: text, verdict: { anyOf: [verdict, { type: "null" }] }, verdictMatch: boolean,
  mustFindHits: count, mustFindTotal: count, recall: boolean, falsePositive: boolean, lineAnchorValid: boolean,
  formatOk: boolean, findingCount: count, blockingFindingCount: count, noiseFindingCount: count,
  criticPruneError: boolean, cheatDetected: boolean, baitExposed: boolean,
};
const aggregateFields = {
  recall: rate, falsePositiveRate: rate, invalidJsonRate: rate, verdictMatchRate: rate,
  lineAnchorValidRate: rate, meanDurationMs: nonnegative, recallByFixture: rateRecord,
  criticPruneErrorRate: rate, recallByTier: rateRecord, meanNoisePerPositive: nonnegative,
  cheatDetectedCount: count, baitExposureCount: count, criticPrunedRecallCount: count,
};
const reportFields = {
  promptHash: text, runner: { enum: RUNNERS }, model: { anyOf: [text, { type: "null" }] },
  effort: { anyOf: [text, { type: "null" }] }, draws: positive, createdAt: text,
  baseline: boolean, holdout: { enum: ["include", "exclude", "only"] },
  results: { type: "array", minItems: 1, items: object({
    fixtureId: text, draw: count, score: object({ ...scoreFields, robustness, error: text }, Object.keys(scoreFields)),
    durationMs: nonnegative, calls: count, retries: count,
    findings, candidateFindings: findings,
    matchEvidence: evidence, candidateMatchEvidence: evidence, operationalFailure: text, fastPath: { const: "docs" },
  }, ["fixtureId", "draw", "score", "durationMs", "calls", "retries"]) },
  aggregates: object({ ...aggregateFields, mustFindHitRateByFixture: rateRecord, mustFindHitRate: rate,
    recallByDefectClass: rateRecord, lineAnchorValidRateByDefectClass: rateRecord,
  }, Object.keys(aggregateFields)),
};
const extensionFields = {
  gitSha: { type: "string", pattern: "^[a-f0-9]{40}$" }, fixtureSetHash: text, scorerHash: text,
  fixtures: { type: "array", minItems: 1, uniqueItems: true, items: text }, fixtureKinds: recordOf({ enum: ["positive", "negative", "parity", "honeypot"] }),
  fixtureTiers: recordOf({ enum: [1, 2, 3] }), fixtureDefectClasses: recordOf(text), anticheatVersion: positive,
  gateClass: { enum: ["R", "D"] }, provider: text, route: text, runnerVersion: text,
  runnerEnvironment: text, privateEnvironment: boolean,
};
const ajv = new Ajv({ strict: true, allErrors: true });
const validateReport = ajv.compile<PhaseTwoReport>(object({ ...reportFields, ...extensionFields },
  [...Object.keys(reportFields), ...Object.keys(extensionFields).filter((key) => key !== "fixtureDefectClasses")]));
const validatePolicy = ajv.compile<PhaseTwoQualificationPolicy>(object({
  id: text, broadDraws: positive, deepDraws: positive, consistencyK: positive,
  floors: object(Object.fromEntries(PHASE_TWO_FLOORS.map((key) => [key, {
    anyOf: [key === "minNoisePerPositive" ? nonnegative : rate, { type: "null" }],
  }])), [...PHASE_TWO_FLOORS], false),
}, undefined, false));

export function parsePhaseTwoReport(input: unknown): PhaseTwoReport {
  if (!validateReport(input)) throw new Error(`invalid Phase 2 report: ${ajv.errorsText(validateReport.errors)}`);
  if (!Number.isFinite(Date.parse(input.createdAt))) throw new Error("invalid Phase 2 report creation date");
  for (const draw of input.results) {
    if (draw.score.fixtureId !== draw.fixtureId) throw new Error("draw score fixture identity mismatch");
    for (const finding of [...draw.findings ?? [], ...draw.candidateFindings ?? []]) {
      if (finding.lineEnd < finding.lineStart) throw new Error("invalid Phase 2 finding line range");
    }
    for (const item of [...draw.matchEvidence ?? [], ...draw.candidateMatchEvidence ?? []]) {
      if (item.lineRange && item.lineRange[1] < item.lineRange[0]) throw new Error("invalid Phase 2 evidence line range");
    }
  }
  return input;
}

export function parsePhaseTwoPolicy(input: unknown): PhaseTwoQualificationPolicy {
  if (!validatePolicy(input)) throw new Error(`invalid Phase 2 policy: ${ajv.errorsText(validatePolicy.errors)}`);
  if (input.consistencyK > input.deepDraws) throw new Error("Phase 2 consistency k must be <= deep draws");
  return input;
}

function validateAggregates(report: PhaseTwoReport, specs: readonly FixtureSpec[]): void {
  const results = report.results;
  const positiveIds = new Set(specs.filter((spec) => spec.kind === "positive").map((spec) => spec.id));
  const negativeIds = new Set(specs.filter((spec) => spec.kind === "negative").map((spec) => spec.id));
  const positives = results.filter((draw) => positiveIds.has(draw.fixtureId));
  const negatives = results.filter((draw) => negativeIds.has(draw.fixtureId));
  const ratio = (hits: number, total: number) => total ? hits / total : 0;
  const check = (key: keyof typeof aggregateFields, expected: number) => {
    if (report.aggregates[key] !== expected) throw new Error(`Phase 2 aggregate ${key} does not match draws`);
  };
  check("recall", ratio(positives.filter((draw) => draw.score.recall).length, positives.length));
  check("falsePositiveRate", ratio(negatives.filter((draw) => draw.score.falsePositive).length, negatives.length));
  check("invalidJsonRate", ratio(results.filter((draw) => !draw.score.formatOk).length, results.length));
  check("verdictMatchRate", ratio(results.filter((draw) => draw.score.verdictMatch).length, results.length));
  check("lineAnchorValidRate", ratio(results.filter((draw) => draw.score.lineAnchorValid).length, results.length));
  check("meanDurationMs", ratio(results.reduce((sum, draw) => sum + draw.durationMs, 0), results.length));
  check("criticPruneErrorRate", ratio(positives.filter((draw) => draw.score.criticPruneError).length, positives.length));
  check("meanNoisePerPositive", ratio(positives.reduce((sum, draw) => sum + draw.score.noiseFindingCount, 0), positives.length));
  const recallByFixture = Object.fromEntries(specs.map((spec) => {
    const draws = results.filter((draw) => draw.fixtureId === spec.id);
    return [spec.id, ratio(draws.filter((draw) => draw.score.recall).length, draws.length)];
  }));
  const recallByTier = Object.fromEntries([1, 2, 3].flatMap((tier) => {
    const ids = new Set(specs.filter((spec) => spec.kind === "positive" && (spec.tier ?? 2) === tier).map((spec) => spec.id));
    const draws = results.filter((draw) => ids.has(draw.fixtureId));
    return draws.length ? [[`t${tier}`, ratio(draws.filter((draw) => draw.score.recall).length, draws.length)]] : [];
  }));
  const mustFindHitRateByFixture = Object.fromEntries([...new Set(results.map((draw) => draw.fixtureId))].flatMap((fixtureId) => {
    const draws = results.filter((draw) => draw.fixtureId === fixtureId && draw.score.mustFindTotal > 0);
    return draws.length ? [[fixtureId, draws.reduce((sum, draw) => sum + draw.score.mustFindHits / draw.score.mustFindTotal, 0) / draws.length]] : [];
  }));
  const mustFindRates = Object.values(mustFindHitRateByFixture);
  if (report.aggregates.mustFindHitRate !== undefined && report.aggregates.mustFindHitRate !== ratio(mustFindRates.reduce((sum, value) => sum + value, 0), mustFindRates.length)) {
    throw new Error("Phase 2 aggregate mustFindHitRate does not match draws");
  }
  if (report.aggregates.mustFindHitRateByFixture !== undefined && !sameRecord(report.aggregates.mustFindHitRateByFixture, mustFindHitRateByFixture)) {
    throw new Error("Phase 2 aggregate mustFindHitRateByFixture does not match draws");
  }
  for (const [key, flag] of [["recallByDefectClass", "recall"], ["lineAnchorValidRateByDefectClass", "lineAnchorValid"]] as const) {
    const actual = report.aggregates[key];
    if (actual === undefined) continue;
    const expected = Object.fromEntries([...new Set(specs.filter((spec) => spec.kind === "positive").map((spec) => spec.defectClass))].map((family) => {
      const ids = new Set(specs.filter((spec) => spec.kind === "positive" && spec.defectClass === family).map((spec) => spec.id));
      const draws = results.filter((draw) => ids.has(draw.fixtureId));
      return [family, ratio(draws.filter((draw) => draw.score[flag]).length, draws.length)];
    }));
    if (!sameRecord(actual, expected)) throw new Error(`Phase 2 aggregate ${key} does not match draws`);
  }
  if (!sameRecord(report.aggregates.recallByFixture, recallByFixture) || !sameRecord(report.aggregates.recallByTier, recallByTier)) {
    throw new Error("Phase 2 aggregate recall records do not match draws");
  }
}

export function admitPhaseTwoReports(
  campaign: { readonly broad: PhaseTwoReport; readonly deep: PhaseTwoReport },
  specs: readonly FixtureSpec[], policy: PhaseTwoQualificationPolicy,
): void {
  const tierOne = specs.filter((spec) => spec.kind === "positive" && spec.tier === 1);
  for (const [name, report, selected, draws] of [
    ["broad", campaign.broad, specs, policy.broadDraws],
    ["deep", campaign.deep, tierOne, policy.deepDraws],
  ] as const) {
    const fail = (reason: string): never => { throw new Error(`Phase 2 ${name}: ${reason}`); };
    if (report.draws !== draws || !isCompleteReport(report, selected.map((spec) => spec.id))) fail("incomplete fixture/draw coverage");
    if (report.holdout !== "include" || report.gateClass !== "R") fail("holdout include and gate class R are required");
    if (report.fixtureSetHash !== fixtureSetHash(selected)) fail("fixture subset hash mismatch");
    if (report.promptHash !== promptHash() || !hasCurrentScorer(report) || report.anticheatVersion !== ANTICHEAT_VERSION) fail("stale prompt/scorer/anticheat identity");
    const expected = fixtureClassifications(selected);
    if (!sameRecord(report.fixtureKinds, expected.fixtureKinds) || !sameRecord(report.fixtureTiers, expected.fixtureTiers)) fail("fixture classifications mismatch");
    if (report.fixtureDefectClasses !== undefined && !sameRecord(report.fixtureDefectClasses, Object.fromEntries(selected.map((spec) => [spec.id, spec.defectClass])))) fail("fixture families mismatch");
    if ([report.model, report.effort, report.provider, report.route, report.runnerVersion].some((value) => typeof value === "string" && /^(unknown|private|unspecified|unresolved)$/i.test(value.trim()))) fail("unknown or private lane identity");
    const environmentError = runnerEnvironmentAttestationError(report) ?? comparisonEnvironmentError(report);
    if (environmentError) fail(environmentError);
    if (!hasConsistentCheatDetection(report) || report.aggregates.cheatDetectedCount !== 0) fail("inconsistent or compromised anti-cheat evidence");
    if (operationalFailures(report).length) fail("operational failures remain");
    for (const draw of report.results) {
      const gold = expected.expectedByFixture?.[draw.fixtureId];
      if (!gold) throw new Error(`Phase 2 ${name}: missing fixture gold`);
      const fastPath = "fastPath" in draw && draw.fastPath === "docs";
      if (fastPath && (!expected.fastPathFixtureIds?.includes(draw.fixtureId) || draw.calls !== 0)) fail("invalid docs fast path");
      if (draw.score.formatOk && draw.calls === 0 && !fastPath) fail("successful zero-call draw requires docs fast path");
      validateStoredScore(draw, gold, fastPath);
      const finalEvidence = matchEvidence((draw.findings ?? []).map((finding) => ({ ...finding, confidence: 1, suggestedFix: "", validation: "" })), gold);
      const candidateEvidence = matchEvidence((draw.candidateFindings ?? []).map((finding) => ({ ...finding, confidence: 1, suggestedFix: "", validation: "" })), gold);
      if (draw.matchEvidence !== undefined && !isDeepStrictEqual(draw.matchEvidence, finalEvidence)) fail("final match evidence does not match findings");
      if (draw.candidateMatchEvidence !== undefined) {
        if (draw.candidateFindings === undefined || !isDeepStrictEqual(draw.candidateMatchEvidence, candidateEvidence)) fail("candidate match evidence does not match retained candidate findings");
      }
      const pruned = finalEvidence.some((item, index) => item.findingIndex === null && candidateEvidence[index]?.findingIndex !== null && candidateEvidence[index]?.findingIndex !== undefined);
      if (draw.score.criticPruneError !== pruned) fail("critic prune error does not match evidence");
    }
    validateAggregates(report, selected);
  }
  for (const key of ["gitSha", "runner", "model", "effort", "provider", "route", "runnerVersion", "runnerEnvironment", "privateEnvironment"] as const) {
    if (campaign.broad[key] !== campaign.deep[key]) throw new Error(`Phase 2 lane/source mismatch: ${key}`);
  }
}
