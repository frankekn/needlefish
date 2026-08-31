import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Report } from "./shared/types";
import { scorerHash } from "./shared/scorer-hash";
import {
  balancedReviewAccuracy,
  renderSite,
  type Lane,
  type LaneConfig,
  type LeaderboardManifest,
  usableSpecificity,
} from "./gen-site";

const report = {
  ...(JSON.parse(
    readFileSync("eval/results/weekly/2026-08-23.json", "utf8"),
  ) as Report),
  scorerHash: scorerHash(),
  gateClass: "R" as const,
};

function config(reportPath: string, name: string): LaneConfig {
  return {
    report: reportPath,
    name,
    provider: "Test provider",
    route: "Test subscription",
    runnerVersion: "test-runner 1.0.0",
    status: name === "Deployed" ? "Deployed" : "Candidate",
  };
}

function setup(): { manifest: LeaderboardManifest; lanes: Lane[] } {
  const configs = [
    config("results/deployed.json", "Deployed"),
    config("results/candidate-a.json", "Candidate A"),
    config("results/candidate-b.json", "Candidate B"),
  ];
  return {
    manifest: {
      updated: "2026-08-30",
      baseline: configs[0].report,
      lanes: configs,
      blocked: [
        {
          name: "Unavailable model",
          model: "unavailable-model",
          provider: "Test subscription",
          reason: "Not exposed by the provider.",
        },
      ],
      excluded: [
        {
          name: "Compromised model",
          model: "compromised-model",
          provider: "Test subscription",
          reason: "Anti-cheat detection fired.",
          report: "results/compromised.json",
        },
      ],
    },
    lanes: configs.map((laneConfig) => ({ config: laneConfig, report })),
  };
}

test("renderSite publishes comparable lanes and blocked routes", () => {
  const { manifest, lanes } = setup();
  const html = renderSite(manifest, lanes);
  assert.match(html, /Current leaderboard/);
  assert.match(html, /Candidate A/);
  assert.match(html, /test-runner 1\.0\.0/);
  assert.match(html, /Test subscription/);
  assert.match(html, /tree\/main\/eval\/results">Raw reports/);
  assert.match(
    html,
    new RegExp(
      `${report.fixtures?.length} fixtures × 3 draws · include holdouts · anti-cheat v2`,
    ),
  );
  assert.match(html, /Unavailable model/);
  assert.match(html, /Not ranked/);
  assert.match(html, /Compromised model/);
  assert.match(html, /aria-label="Benchmark trust facts"/);
  assert.match(html, /Skip to leaderboard/);
  assert.match(html, /aria-label="Qualified model leaderboard" tabindex="0"/);
  assert.match(html, /Scroll horizontally to see every metric/);
  assert.match(html, /Disqualified: Tier-1 miss/);
  assert.match(html, /Release 0\.4\.2 is blocked/);
  assert.match(html, /Balanced Review Accuracy/);
  assert.match(html, /seed 6ba00010/);
});

test("balancedReviewAccuracy counts an invalid negative once", () => {
  const scored = {
    ...report,
    fixtureKinds: { positive: "positive", negative: "negative" } as const,
    results: [
      { ...report.results[0], fixtureId: "positive", score: { ...report.results[0].score, recall: true, formatOk: true } },
      { ...report.results[0], fixtureId: "negative", score: { ...report.results[0].score, falsePositive: false, formatOk: false } },
    ],
  };
  assert.equal(balancedReviewAccuracy(scored), 0.5);
  assert.equal(usableSpecificity(scored), 0);
  assert.throws(
    () => balancedReviewAccuracy({ ...scored, fixtureKinds: {} }),
    /fixture kind is missing/,
  );
});

test("renderSite rejects a lane with a different fixture set", () => {
  const { manifest, lanes } = setup();
  const mismatched = lanes.map((lane, index) =>
    index === 1
      ? {
          ...lane,
          report: { ...lane.report, fixtureSetHash: "different" },
        }
      : lane,
  );
  assert.throws(
    () => renderSite(manifest, mismatched),
    /fixtureSetHash does not match the baseline/,
  );
});

test("renderSite rejects a reduced-contract lane", () => {
  const { manifest, lanes } = setup();
  const reduced = lanes.map((lane, index) =>
    index === 1
      ? { ...lane, report: { ...lane.report, gateClass: "D" as const } }
      : lane,
  );
  assert.throws(
    () => renderSite(manifest, reduced),
    /public lanes require gate class R/,
  );
});

test("renderSite rejects different fixture IDs with matching hashes", () => {
  const { manifest, lanes } = setup();
  const originalId = report.fixtures?.[0];
  assert.ok(originalId);
  const replacementId = "different-fixture";
  const changed = lanes.map((lane, index) =>
    index === 1
      ? {
          ...lane,
          report: {
            ...lane.report,
            fixtures: lane.report.fixtures?.map((id) =>
              id === originalId ? replacementId : id,
            ),
            fixtureKinds: Object.fromEntries(
              Object.entries(lane.report.fixtureKinds ?? {}).map(([id, kind]) => [
                id === originalId ? replacementId : id,
                kind,
              ]),
            ),
            results: lane.report.results.map((result) =>
              result.fixtureId === originalId
                ? { ...result, fixtureId: replacementId }
                : result,
            ),
          },
        }
      : lane,
  );
  assert.throws(
    () => renderSite(manifest, changed),
    /fixture manifest does not match the baseline/,
  );
});
