import type { DrawResult, FixtureSpec } from "./types";

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
