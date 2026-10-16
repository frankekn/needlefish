import assert from "node:assert/strict";
import test from "node:test";
import { loadFixtures } from "./fixture-catalog";
import { fixtureClassifications, qualifyRuntimeConfiguration, readLane, readManifest } from "../gen-site";

const manifest = readManifest();
const config = manifest.lanes.find((lane) => lane.status === "Deployed");
assert.ok(config);
const lane = readLane(config);
const catalog = await loadFixtures(null);
const ids = new Set(lane.report.fixtures);
const historicalCanonical = { ...fixtureClassifications(catalog.filter((fixture) => ids.has(fixture.id))), promptHash: lane.report.promptHash };

test("qualification admits the report before matching identity and keeps the policy explicit", () => {
  assert.deepEqual(qualifyRuntimeConfiguration(lane.report, lane, historicalCanonical), {
    matchStatus: "tested", policyVersion: "public-leaderboard-interim-v1", reportId: "results/2026-09-09-pi-deepseek-v41-flash-high-x3.json",
  });
  assert.deepEqual(qualifyRuntimeConfiguration({ ...lane.report, runnerVersion: "different" }, lane, historicalCanonical), { matchStatus: "unqualified", reason: "different_configuration" });
  assert.deepEqual(qualifyRuntimeConfiguration({ ...lane.report, runnerVersion: undefined }, lane, historicalCanonical), { matchStatus: "unqualified", reason: "unknown_identity" });
  assert.deepEqual(qualifyRuntimeConfiguration(lane.report, undefined, historicalCanonical), { matchStatus: "unqualified", reason: "missing_report" });
  assert.deepEqual(qualifyRuntimeConfiguration(lane.report, { ...lane, report: { ...lane.report, privateEnvironment: true } }, historicalCanonical), { matchStatus: "unqualified", reason: "report_not_admitted" });
  assert.deepEqual(qualifyRuntimeConfiguration(lane.report, { ...lane, report: { ...lane.report, results: [] } }, historicalCanonical), { matchStatus: "unqualified", reason: "report_not_admitted" });
});

test("a historical artifact cannot qualify against the current full fixture and prompt contract", () => {
  assert.deepEqual(qualifyRuntimeConfiguration(lane.report, lane, fixtureClassifications(catalog)), { matchStatus: "unqualified", reason: "report_not_admitted" });
});

test("an admitted complete report that missed the quality gate cannot qualify an identical configuration", () => {
  const baselineConfig = manifest.lanes.find((candidate) => candidate.report === manifest.baseline);
  assert.ok(baselineConfig);
  const belowGate = readLane(baselineConfig);
  const canonical = { ...historicalCanonical, promptHash: belowGate.report.promptHash };
  assert.deepEqual(qualifyRuntimeConfiguration(belowGate.report, belowGate, canonical), { matchStatus: "unqualified", reason: "quality_gate_failed" });
});
