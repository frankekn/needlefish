import { measureIndependentQuality } from "./quality-oracle";
import { isCompleteReport } from "./report-completeness";
import { matchesSpec } from "./score";
import type { DrawFinding, DrawResult, Expected, FixtureSpec, MatchSpec, Report } from "./types";

export interface CodeReviewQualificationPolicy {
  readonly id: string;
  readonly broadDraws: number;
  readonly deepDraws: number;
  readonly minNoisePerPositive: number;
  readonly minTierOneAggregate: number;
  readonly minTierOnePerFixture: number;
  readonly minTierOneFamilyRecall: number;
  readonly minTierOneFamilyLocalization: number;
  readonly minActionablePrecision: number;
  readonly requiredTierOneDraws?: number;
}

export const CODE_REVIEW_POLICY_V1: CodeReviewQualificationPolicy = {
  id: "code-review-v1",
  broadDraws: 3,
  deepDraws: 6,
  minNoisePerPositive: 0.12,
  minTierOneAggregate: 86 / 90,
  minTierOnePerFixture: 4 / 6,
  // These are intentionally explicit calibration inputs. They remain unset
  // in the interim leaderboard gate until the Phase 2 campaign calibrates them.
  minTierOneFamilyRecall: 0,
  minTierOneFamilyLocalization: 0,
  minActionablePrecision: 0,
  requiredTierOneDraws: 90,
};

export interface QualificationResult {
  readonly policyId: string;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly tierOne: { readonly hits: number; readonly total: number; readonly perFixture: Readonly<Record<string, number>> };
  readonly recallByFamily: Readonly<Record<string, number>>;
  readonly localizationByFamily: Readonly<Record<string, number>>;
  readonly actionablePrecision: number;
  readonly meanNoisePerPositive: number;
}

export interface FixturePlanCheck {
  readonly ready: boolean;
  readonly errors: readonly string[];
  readonly tierOneCount: number;
  readonly familyCounts: Readonly<Record<string, number>>;
}

export function checkPhaseTwoFixturePlan(
  specs: readonly Pick<FixtureSpec, "id" | "kind" | "tier" | "defectClass">[],
): FixturePlanCheck {
  const tierOne = specs.filter((spec) => spec.kind === "positive" && spec.tier === 1);
  const familyCounts: Record<string, number> = {};
  for (const spec of tierOne) familyCounts[spec.defectClass] = (familyCounts[spec.defectClass] ?? 0) + 1;
  const errors: string[] = [];
  if (tierOne.length < 15) errors.push(`need at least 15 Tier-1 fixtures (found ${tierOne.length})`);
  if (Object.keys(familyCounts).length < 5) errors.push(`need at least 5 Tier-1 defect families (found ${Object.keys(familyCounts).length})`);
  for (const [family, count] of Object.entries(familyCounts)) {
    if (count < 2) errors.push(`Tier-1 family ${family} needs at least 2 fixtures (found ${count})`);
  }
  return { ready: errors.length === 0, errors, tierOneCount: tierOne.length, familyCounts };
}

export function evaluateCodeReviewQualification(
  results: readonly DrawResult[],
  specs: readonly Pick<FixtureSpec, "id" | "kind" | "tier" | "defectClass">[],
  policy: CodeReviewQualificationPolicy = CODE_REVIEW_POLICY_V1,
): QualificationResult {
  const byId = new Map(specs.map((spec) => [spec.id, spec]));
  const tierOne = results.filter((result) => byId.get(result.fixtureId)?.tier === 1);
  const tierOneHits = tierOne.filter((result) => result.score.recall).length;
  const perFixture: Record<string, number> = {};
  for (const spec of specs.filter((item) => item.kind === "positive" && item.tier === 1)) {
    const draws = tierOne.filter((result) => result.fixtureId === spec.id);
    perFixture[spec.id] = draws.length ? draws.filter((result) => result.score.recall).length / draws.length : 0;
  }
  const positive = results.filter((result) => byId.get(result.fixtureId)?.kind === "positive");
  const familyBuckets = new Map<string, { total: number; hits: number; anchored: number }>();
  for (const result of positive) {
    const family = byId.get(result.fixtureId)?.defectClass;
    if (!family) continue;
    const bucket = familyBuckets.get(family) ?? { total: 0, hits: 0, anchored: 0 };
    bucket.total += 1;
    if (result.score.recall) bucket.hits += 1;
    if (result.score.lineAnchorValid) bucket.anchored += 1;
    familyBuckets.set(family, bucket);
  }
  const recallByFamily = Object.fromEntries([...familyBuckets].map(([family, bucket]) => [family, bucket.hits / bucket.total]));
  const localizationByFamily = Object.fromEntries([...familyBuckets].map(([family, bucket]) => [family, bucket.anchored / bucket.total]));
  const noise = positive.length ? positive.reduce((sum, result) => sum + result.score.noiseFindingCount, 0) / positive.length : 0;
  const blocking = positive.reduce((sum, result) => sum + result.score.blockingFindingCount, 0);
  const actionablePrecision = blocking ? positive.reduce((sum, result) => sum + result.score.mustFindHits, 0) / blocking : 1;
  const reasons: string[] = [];
  if ((policy.requiredTierOneDraws !== undefined && tierOne.length !== policy.requiredTierOneDraws) || tierOneHits / Math.max(1, tierOne.length) < policy.minTierOneAggregate) reasons.push("Tier-1 aggregate floor");
  if (Object.values(perFixture).some((value) => value < policy.minTierOnePerFixture)) reasons.push("Tier-1 per-fixture floor");
  if (Object.entries(recallByFamily).some(([, value]) => value < policy.minTierOneFamilyRecall)) reasons.push("Tier-1 family recall floor");
  if (Object.entries(localizationByFamily).some(([, value]) => value < policy.minTierOneFamilyLocalization)) reasons.push("Tier-1 family localization floor");
  if (noise > policy.minNoisePerPositive) reasons.push("positive noise floor");
  if (actionablePrecision < policy.minActionablePrecision) reasons.push("actionable precision floor");
  return {
    policyId: policy.id,
    eligible: reasons.length === 0,
    reasons,
    tierOne: { hits: tierOneHits, total: tierOne.length, perFixture },
    recallByFamily,
    localizationByFamily,
    actionablePrecision,
    meanNoisePerPositive: noise,
  };
}

export function fixtureDrawCount(
  results: readonly DrawResult[],
  fixtureId: string,
): number {
  return results.filter((result) => result.fixtureId === fixtureId).length;
}

export type QualityRate =
  | { readonly status: "measured"; readonly value: number; readonly numerator: number; readonly denominator: number }
  | { readonly status: "unknown"; readonly reason: string };

type PhaseTwoFloor =
  | "minNoisePerPositive"
  | "minTierOneAggregate"
  | "minTierOnePerFixture"
  | "minTierOneFamilyRecall"
  | "minTierOneFamilyLocalization"
  | "minActionablePrecision";

export interface PhaseTwoQualificationPolicy {
  readonly id: string;
  readonly broadDraws: number;
  readonly deepDraws: number;
  readonly consistencyK: number;
  readonly floors: { readonly [Key in PhaseTwoFloor]: number | null } & {
    readonly maxNegativeFalsePositiveDrawRate: number | null;
    readonly minSeverityCalibration: number | null;
    readonly minObservedPassK: number | null;
  };
}

export interface PhaseTwoQualificationResult {
  readonly protocol: "phase-two";
  readonly policyId: string;
  readonly eligible: boolean;
  readonly reasons: readonly string[];
  readonly tierOne: QualificationResult["tierOne"];
  readonly recallByTierOneFamily: Readonly<Record<string, QualityRate>>;
  readonly broadRecallByFamilyDiagnostic: Readonly<Record<string, QualityRate>>;
  readonly localizationByTierOneFamily: Readonly<Record<string, QualityRate>>;
  readonly requiredGoldMatchPrecisionProxy: {
    readonly micro: QualityRate;
    readonly meanPerEmittingReview: QualityRate;
    readonly abstentionDraws: number;
  };
  readonly negativeFalsePositiveDrawRate: QualityRate;
  readonly meanNoisePerPositive: QualityRate;
  readonly observedPassK: { readonly k: number; readonly fixtureWeighted: QualityRate };
  readonly actionablePrecision: QualityRate;
  readonly severityCalibration: QualityRate;
}

function rate(numerator: number, denominator: number): QualityRate {
  return denominator > 0
    ? { status: "measured", value: numerator / denominator, numerator, denominator }
    : { status: "unknown", reason: "no observations" };
}

function anchoredGold(expected: Expected, localization: boolean): readonly MatchSpec[] | undefined {
  const gold = expected.mustFind ?? [];
  if (gold.length === 0) return undefined;
  const anchored = gold.map((spec) => ({
    ...spec,
    file: spec.file ?? expected.anchorFile,
    ...(localization ? { lineRange: spec.lineRange ?? expected.anchorLineRange } : {}),
  }));
  return anchored.every((spec) => spec.file && (!localization || spec.lineRange))
    ? anchored
    : undefined;
}

function uniqueGoldMatches(findings: readonly DrawFinding[], gold: readonly MatchSpec[]): number {
  const owner = new Map<number, number>();
  function assign(goldIndex: number, visited: Set<number>): boolean {
    for (let index = 0; index < findings.length; index++) {
      if (visited.has(index) || !matchesSpec(findings[index], gold[goldIndex])) continue;
      visited.add(index);
      const previous = owner.get(index);
      if (previous === undefined || assign(previous, visited)) {
        owner.set(index, goldIndex);
        return true;
      }
    }
    return false;
  }
  for (let index = 0; index < gold.length; index++) assign(index, new Set());
  return owner.size;
}

function familyRecall(results: readonly DrawResult[], specs: readonly FixtureSpec[]): Readonly<Record<string, QualityRate>> {
  return Object.fromEntries([...new Set(specs.map((spec) => spec.defectClass))].map((family) => {
    const ids = new Set(specs.filter((spec) => spec.defectClass === family).map((spec) => spec.id));
    const draws = results.filter((result) => ids.has(result.fixtureId));
    return [family, rate(draws.filter((result) => result.score.recall).length, draws.length)];
  }));
}

function observedSubsetPassRate(hits: number, draws: number, k: number): number {
  if (hits < k) return 0;
  let value = 1;
  for (let index = 0; index < k; index++) value *= (hits - index) / (draws - index);
  return value;
}

export function evaluatePhaseTwoQualification(
  campaign: { readonly broad: Report; readonly deep: Report },
  specs: readonly FixtureSpec[],
  policy: PhaseTwoQualificationPolicy,
  oracle?: unknown,
): PhaseTwoQualificationResult {
  if (
    !Number.isInteger(policy.broadDraws) || policy.broadDraws < 1 ||
    !Number.isInteger(policy.deepDraws) || policy.deepDraws < 1 ||
    !Number.isInteger(policy.consistencyK) || policy.consistencyK < 1 || policy.consistencyK > policy.deepDraws
  ) throw new Error("Phase 2 draw counts and consistency k must be positive integers, with k <= deep draws");
  const tierOneSpecs = specs.filter((spec) => spec.kind === "positive" && spec.tier === 1);
  for (const [name, report, selected, draws] of [
    ["broad", campaign.broad, specs, policy.broadDraws],
    ["deep", campaign.deep, tierOneSpecs, policy.deepDraws],
  ] as const) {
    if (report.draws !== draws || !isCompleteReport(report, selected.map((spec) => spec.id))) {
      throw new Error(`Phase 2 ${name} report must contain exactly one result for every expected fixture and draw index`);
    }
  }
  const broadPositiveSpecs = specs.filter((spec) => spec.kind === "positive");
  const broadPositiveIds = new Set(broadPositiveSpecs.map((spec) => spec.id));
  const positives = campaign.broad.results.filter((result) => broadPositiveIds.has(result.fixtureId));
  const negatives = campaign.broad.results.filter((result) => specs.some((spec) => spec.id === result.fixtureId && spec.kind === "negative"));
  const deep = campaign.deep.results;
  const perFixture = Object.fromEntries(tierOneSpecs.map((spec) => {
    const draws = deep.filter((result) => result.fixtureId === spec.id);
    return [spec.id, draws.filter((result) => result.score.recall).length / draws.length];
  }));
  const recallByTierOneFamily = familyRecall(deep, tierOneSpecs);
  const localizationByTierOneFamily = Object.fromEntries([...new Set(tierOneSpecs.map((spec) => spec.defectClass))].map((family) => {
    const familySpecs = tierOneSpecs.filter((spec) => spec.defectClass === family);
    let hits = 0;
    for (const spec of familySpecs) {
      const gold = anchoredGold(spec.expected, true);
      if (gold === undefined) return [family, { status: "unknown", reason: "missing file or line oracle" } satisfies QualityRate];
      for (const draw of deep.filter((result) => result.fixtureId === spec.id)) {
        if (draw.findings === undefined) return [family, { status: "unknown", reason: "missing findings" } satisfies QualityRate];
        if (draw.score.recall && uniqueGoldMatches(draw.findings, gold) === gold.length) hits++;
      }
    }
    return [family, rate(hits, familySpecs.length * policy.deepDraws)];
  }));
  let matched = 0;
  let blocking = 0;
  let abstentionDraws = 0;
  const perEmittingReview: number[] = [];
  let proxyUnknown: string | undefined;
  for (const spec of specs.filter((spec) => spec.kind === "positive" || spec.kind === "negative")) {
    const gold = spec.kind === "positive" ? anchoredGold(spec.expected, false) : [];
    for (const draw of campaign.broad.results.filter((draw) => draw.fixtureId === spec.id)) {
      if (draw.findings === undefined) {
        proxyUnknown = "missing findings or file oracle";
        continue;
      }
      const findings = draw.findings.filter((finding) => finding.severity !== "P3");
      if (findings.length === 0) abstentionDraws++;
      if (gold === undefined) {
        proxyUnknown = "missing findings or file oracle";
        continue;
      }
      const hits = uniqueGoldMatches(findings, gold);
      matched += hits;
      blocking += findings.length;
      if (findings.length > 0) perEmittingReview.push(hits / findings.length);
    }
  }
  const unknownProxy: QualityRate = { status: "unknown", reason: proxyUnknown ?? "no emitted blocking findings" };
  const requiredGoldMatchPrecisionProxy = {
    micro: proxyUnknown ? unknownProxy : rate(matched, blocking),
    meanPerEmittingReview: proxyUnknown ? unknownProxy : rate(perEmittingReview.reduce((sum, value) => sum + value, 0), perEmittingReview.length),
    abstentionDraws,
  };
  const tierOneHits = deep.filter((result) => result.score.recall).length;
  const negativeFalsePositiveDrawRate = rate(negatives.filter((draw) => draw.score.falsePositive).length, negatives.length);
  const meanNoisePerPositive = rate(positives.reduce((sum, draw) => sum + draw.score.noiseFindingCount, 0), positives.length);
  const observedPassK = {
    k: policy.consistencyK,
    fixtureWeighted: rate(tierOneSpecs.reduce((sum, spec) => {
      const draws = deep.filter((draw) => draw.fixtureId === spec.id);
      return sum + observedSubsetPassRate(draws.filter((draw) => draw.score.recall).length, draws.length, policy.consistencyK);
    }, 0), tierOneSpecs.length),
  };
  const { actionablePrecision, severityCalibration } = measureIndependentQuality(campaign, specs, oracle);
  const reasons = [...checkPhaseTwoFixturePlan(specs).errors];
  for (const [name, value] of Object.entries(policy.floors)) {
    if (value === null) reasons.push(`unset floor: ${name}`);
    else if (!Number.isFinite(value) || value < 0 || (name !== "minNoisePerPositive" && value > 1)) throw new Error(`invalid Phase 2 floor: ${name}`);
  }
  function floor(name: keyof PhaseTwoQualificationPolicy["floors"], metric: QualityRate, maximum = false): void {
    if (metric.status === "unknown") reasons.push(`unknown required metric: ${name} (${metric.reason})`);
    else {
      const threshold = policy.floors[name];
      if (threshold !== null && (maximum ? metric.value > threshold : metric.value < threshold)) reasons.push(`failed floor: ${name}`);
    }
  }
  floor("minTierOneAggregate", rate(tierOneHits, deep.length));
  for (const value of Object.values(perFixture)) floor("minTierOnePerFixture", rate(value, 1));
  for (const metric of Object.values(recallByTierOneFamily)) floor("minTierOneFamilyRecall", metric);
  for (const metric of Object.values(localizationByTierOneFamily)) floor("minTierOneFamilyLocalization", metric);
  floor("minNoisePerPositive", meanNoisePerPositive, true);
  floor("maxNegativeFalsePositiveDrawRate", negativeFalsePositiveDrawRate, true);
  floor("minObservedPassK", observedPassK.fixtureWeighted);
  floor("minActionablePrecision", actionablePrecision);
  floor("minSeverityCalibration", severityCalibration);
  if ([...campaign.broad.results, ...deep].some((draw) => !draw.score.formatOk || draw.score.cheatDetected)) reasons.push("invalid or compromised draw");
  return {
    protocol: "phase-two", policyId: policy.id, eligible: reasons.length === 0, reasons: [...new Set(reasons)],
    tierOne: { hits: tierOneHits, total: deep.length, perFixture },
    recallByTierOneFamily,
    broadRecallByFamilyDiagnostic: familyRecall(positives, broadPositiveSpecs),
    localizationByTierOneFamily, requiredGoldMatchPrecisionProxy,
    negativeFalsePositiveDrawRate, meanNoisePerPositive, observedPassK,
    actionablePrecision, severityCalibration,
  };
}
