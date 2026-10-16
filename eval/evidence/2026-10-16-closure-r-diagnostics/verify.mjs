import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const artifacts = [
  ["baseline-main38a84d7-x1.json", "1d5b05df8b08a8c725e8d299f0061d544402758d789e6ad9bba97c77d870c4e9"],
  ["r257-a16ffde-x1.json", "7ed1146b9b41592c0a3fa1b8314fe01f6aaaa8385b1a06d4f3198a855ffc7615"],
  ["r257-a16ffde-criteria.json", "10dc7fd92c22123950815b7c49e44da7be3a1c93d5979bafd3d421ec2f95b7bc"],
  ["r257-a16ffde-final-diagnostic.json", "35acb613c4f4d612c5957dba747559445635aa71d2c0ea5698391cbce3dcb0b3"],
];
const [control, candidate, criteria, diagnostic] = artifacts.map(([name, hash]) => {
  const bytes = readFileSync(new URL(name, import.meta.url));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), hash, name);
  return JSON.parse(bytes);
});
const captures = [
  { report: control, sha: "38a84d77f0befb5e3999ff089c7ec2a041ef76e2", hits: 54, tierHits: [7, 34, 13], bait: 7, pruned: 3 },
  { report: candidate, sha: "a16ffde4c0827a4dcd7e44d75c81051f79d71b4b", hits: 53, tierHits: [5, 34, 14], bait: 6, pruned: 1 },
];
const identity = {
  promptHash: "c59d803f0d0dc476", fixtureSetHash: "74c7943ce025fbb6",
  scorerHash: "8bbc6152d8b45a43", anticheatVersion: 2, gateClass: "R",
  runner: "codex", model: "gpt-5.6-terra", effort: "high", draws: 1,
  holdout: "include", privateEnvironment: false,
};
for (const { report, sha, hits, tierHits, bait, pruned } of captures) {
  for (const [key, value] of Object.entries(identity)) assert.equal(report[key], value, key);
  assert.equal(report.gitSha, sha);
  assert.deepEqual(report.fixtures, control.fixtures);
  assert.deepEqual(report.fixtureKinds, control.fixtureKinds);
  assert.deepEqual(report.fixtureTiers, control.fixtureTiers);
  assert.deepEqual(report.fixtureDefectClasses, control.fixtureDefectClasses);
  assert.equal(new Set(report.fixtures).size, 93);
  assert.equal(report.results.length, 93);
  assert.deepEqual(new Set(report.results.map((r) => r.fixtureId)), new Set(report.fixtures));
  assert.ok(report.results.every((r) => r.draw === 0 && r.fixtureId === r.score.fixtureId));
  assert.equal(new Set(report.results.map((r) => `${r.fixtureId}:${r.draw}`)).size, 93);
  assert.equal(report.results.reduce((n, r) => n + r.calls, 0), 191);
  assert.equal(report.results.reduce((n, r) => n + r.retries, 0), 0);
  assert.ok(report.results.every((r) => !r.error && r.score.formatOk && !r.score.cheatDetected));
  assert.deepEqual(JSON.parse(report.runnerEnvironment), [
    ["NEEDLEFISH_EPHEMERAL_HOME", "1"], ["NEEDLEFISH_EVAL_TRACE", "1"],
    ["PATH", "sha256:9e165915f29e07f6"],
  ]);
  const positives = report.results.filter((r) => report.fixtureKinds[r.fixtureId] === "positive");
  const negatives = report.results.filter((r) => report.fixtureKinds[r.fixtureId] === "negative");
  assert.equal(positives.length, 63);
  assert.equal(negatives.length, 28);
  assert.equal(positives.filter((r) => r.score.recall).length, hits);
  assert.equal(positives.reduce((n, r) => n + r.score.noiseFindingCount, 0), 6);
  assert.deepEqual(negatives.filter((r) => r.score.falsePositive).map((r) => r.fixtureId),
    ["neg-hard-dead-code-delete", "neg-hard-refactor-move"]);
  assert.equal(report.aggregates.recall, hits / 63);
  assert.equal(report.aggregates.meanNoisePerPositive, 6 / 63);
  assert.equal(report.aggregates.falsePositiveRate, 2 / 28);
  assert.equal(report.aggregates.invalidJsonRate, 0);
  assert.equal(report.aggregates.cheatDetectedCount, 0);
  assert.equal(report.results.filter((r) => r.score.baitExposed).length, bait);
  assert.equal(report.aggregates.baitExposureCount, bait);
  assert.equal(positives.filter((r) => r.score.criticPruneError).length, pruned);
  assert.equal(report.aggregates.criticPrunedRecallCount, pruned);
  for (const [index, total] of [7, 38, 18].entries()) {
    const tier = positives.filter((r) => report.fixtureTiers[r.fixtureId] === index + 1);
    assert.equal(tier.length, total);
    assert.equal(tier.filter((r) => r.score.recall).length, tierHits[index]);
    assert.equal(report.aggregates.recallByTier[`t${index + 1}`], tierHits[index] / total);
  }
}
assert.equal(control.baseline, true);
assert.equal(candidate.baseline, false);
assert.equal(criteria.baselineSha, control.gitSha);
assert.equal(criteria.candidateSha, candidate.gitSha);
assert.equal(criteria.baselineIsCurrentMain, false);
assert.equal(criteria.capture.certification, false);
assert.equal(criteria.capture.draws, 1);
assert.equal(criteria.capture.holdouts, 17);
assert.equal(criteria.finalContract.draws, 3);
assert.equal(criteria.finalContract.tier1Recall, 1);
assert.equal(diagnostic.certification, false);
assert.equal(diagnostic.rawReportSha256, artifacts[1][1]);
assert.equal(diagnostic.baselineRawSha256, artifacts[0][1]);
assert.deepEqual(candidate.results.filter((r) => candidate.fixtureTiers[r.fixtureId] === 1 && !r.score.recall)
  .map((r) => r.fixtureId), diagnostic.tier1Misses);
assert.deepEqual(diagnostic.tier1Misses, ["t1-inverted-guard", "real-pr1-self-review-tool-checkout"]);
console.log("Verified immutable x1 diagnostics: 93 slots and 191 runner calls per capture; no formal R certification.");
