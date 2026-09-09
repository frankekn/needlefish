import assert from "node:assert/strict";
import test from "node:test";
import type { DrawResult } from "./types";
import { checkPhaseTwoFixturePlan, evaluateCodeReviewQualification } from "./qualification";

function draw(fixtureId: string, recall: boolean, lineAnchorValid = true): DrawResult {
  return {
    fixtureId,
    draw: 0,
    durationMs: 0,
    calls: 0,
    retries: 0,
    findings: [],
    score: {
      fixtureId,
      verdict: "changes_requested",
      verdictMatch: true,
      mustFindHits: recall ? 1 : 0,
      mustFindTotal: 1,
      recall,
      falsePositive: false,
      lineAnchorValid,
      formatOk: true,
      findingCount: recall ? 1 : 0,
      blockingFindingCount: recall ? 1 : 0,
      noiseFindingCount: 0,
      criticPruneError: false,
      cheatDetected: false,
      baitExposed: false,
    },
  };
}

test("qualification reports family and localization metrics without running models", () => {
  const specs = [
    { id: "auth", kind: "positive" as const, tier: 1 as const, defectClass: "authorization" },
    { id: "data", kind: "positive" as const, tier: 1 as const, defectClass: "data-loss" },
  ];
  const results = [
    ...Array.from({ length: 6 }, () => draw("auth", true)),
    ...Array.from({ length: 6 }, (_, index) => draw("data", index !== 0, index !== 1)),
  ];
  const result = evaluateCodeReviewQualification(results, specs, {
    id: "test",
    broadDraws: 3,
    deepDraws: 6,
    minNoisePerPositive: 0.12,
    minTierOneAggregate: 11 / 12,
    minTierOnePerFixture: 5 / 6,
    minTierOneFamilyRecall: 0.8,
    minTierOneFamilyLocalization: 0.8,
    minActionablePrecision: 0.5,
    requiredTierOneDraws: 12,
  });
  assert.equal(result.eligible, true);
  assert.equal(result.recallByFamily.authorization, 1);
  assert.equal(result.recallByFamily["data-loss"], 5 / 6);
  assert.equal(result.localizationByFamily["data-loss"], 5 / 6);
  assert.equal(result.tierOne.hits, 11);
});

test("phase-two fixture readiness fails closed before the corpus is large enough", () => {
  const specs = Array.from({ length: 7 }, (_, index) => ({
    id: `t1-${index}`,
    kind: "positive" as const,
    tier: 1 as const,
    defectClass: `family-${index}`,
  }));
  const check = checkPhaseTwoFixturePlan(specs);
  assert.equal(check.ready, false);
  assert.match(check.errors[0] ?? "", /at least 15/);
  assert.equal(check.tierOneCount, 7);
});
