import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { DrawResult, FixtureKind, Report } from "./shared/types";
import { scorerHash } from "./shared/scorer-hash";
import {
  balancedReviewAccuracy,
  renderSite,
  statisticalRanks,
  validateManifest,
  validateStoredScore,
  type Lane,
  type LaneConfig,
  type LeaderboardManifest,
  usableSpecificity,
} from "./gen-site";

const report = {
  ...(JSON.parse(
    readFileSync("eval/results/weekly/2026-08-23.json", "utf8"),
  ) as Report & { fixtureKinds: Readonly<Record<string, FixtureKind>> }),
  scorerHash: scorerHash(),
  gateClass: "R" as const,
  provider: "Test provider",
  route: "Test subscription",
  runnerVersion: "test-runner 1.0.0",
};

const canonical = {
  fixtureIds: report.fixtures ?? [],
  fixtureKinds: report.fixtureKinds,
  fixtureTiers: report.fixtureTiers ?? {},
  fixtureSetHash: report.fixtureSetHash ?? "",
  promptHash: report.promptHash,
};

function config(reportPath: string, name: string): LaneConfig {
  return {
    report: reportPath,
    name,
    runner: report.runner,
    model: report.model ?? "test-model",
    effort: report.effort ?? "test-effort",
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
  const html = renderSite(manifest, lanes, canonical);
  assert.match(html, /Current leaderboard/);
  assert.match(html, /Candidate A/);
  assert.match(html, /test-runner 1\.0\.0/);
  assert.match(html, /Test subscription/);
  assert.match(html, /operator-attested/);
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
  assert.match(html, /Tier-2/);
  assert.match(html, /Tier-3/);
  assert.match(html, /Verdict match/);
  assert.match(html, /Positive noise \/ review/);
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
    () => renderSite(manifest, mismatched, canonical),
    /fixtureSetHash does not match the current fixture specs/,
  );
});

test("renderSite rejects reports with a stale fixture-set hash", () => {
  const { manifest, lanes } = setup();
  assert.throws(
    () =>
      renderSite(manifest, lanes, {
        ...canonical,
        fixtureSetHash: "current-fixture-specs",
      }),
    /fixtureSetHash does not match the current fixture specs/,
  );
});

test("renderSite rejects reports with a stale prompt hash", () => {
  const { manifest, lanes } = setup();
  assert.throws(
    () =>
      renderSite(manifest, lanes, {
        ...canonical,
        promptHash: "current-prompts",
      }),
    /promptHash does not match the current prompts/,
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
    () => renderSite(manifest, reduced, canonical),
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
            fixtureTiers: Object.fromEntries(
              Object.entries(lane.report.fixtureTiers ?? {}).map(([id, tier]) => [
                id === originalId ? replacementId : id,
                tier,
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
    () => renderSite(manifest, changed, canonical),
    /fixture manifest does not match the current fixture specs/,
  );
});

test("renderSite rejects a fixture omitted from every lane", () => {
  const { manifest, lanes } = setup();
  const omitted = report.fixtures?.find(
    (id) => report.fixtureKinds[id] === "honeypot",
  );
  assert.ok(omitted);
  const changed = lanes.map((lane) => {
    const results = lane.report.results.filter(
      (result) => result.fixtureId !== omitted,
    );
    return {
      ...lane,
      report: {
        ...lane.report,
        fixtures: lane.report.fixtures?.filter((id) => id !== omitted),
        results,
        aggregates: {
          ...lane.report.aggregates,
          invalidJsonRate:
            results.filter((result) => !result.score.formatOk).length /
            results.length,
          verdictMatchRate:
            results.filter((result) => result.score.verdictMatch).length /
            results.length,
          meanDurationMs:
            results.reduce((sum, result) => sum + result.durationMs, 0) /
            results.length,
        },
      },
    };
  });
  assert.throws(
    () => renderSite(manifest, changed, canonical),
    /fixture manifest does not match the current fixture specs/,
  );
});

test("renderSite derives Tier-1 qualification from draw results", () => {
  const { manifest, lanes } = setup();
  const tierOneResult = report.results.find(
    (result) => report.fixtureTiers?.[result.fixtureId] === 1,
  );
  assert.ok(tierOneResult);
  const changed = lanes.map((lane, index) =>
    index === 1
      ? {
          ...lane,
          report: {
            ...lane.report,
            results: lane.report.results.map((result) =>
              result === tierOneResult
                ? { ...result, score: { ...result.score, recall: !result.score.recall } }
                : result,
            ),
          },
        }
      : lane,
  );
  assert.throws(
    () => renderSite(manifest, changed, canonical),
    /Tier-1 recall does not match draw results/,
  );
});

test("renderSite derives Tier-2 and Tier-3 recall from draw results", () => {
  const { manifest, lanes } = setup();
  for (const tier of [2, 3] as const) {
    const changed = lanes.map((lane, index) =>
      index === 1
        ? {
            ...lane,
            report: {
              ...lane.report,
              aggregates: {
                ...lane.report.aggregates,
                recallByTier: {
                  ...lane.report.aggregates.recallByTier,
                  [`t${tier}`]: 0,
                },
              },
            },
          }
        : lane,
    );
    assert.throws(
      () => renderSite(manifest, changed, canonical),
      new RegExp(`Tier-${tier} recall does not match draw results`),
    );
  }
});

test("renderSite disqualifies positive-fixture noise above the production envelope", () => {
  const { manifest, lanes } = setup();
  const changed = lanes.map((lane, index) => {
    if (index !== 0) return lane;
    const results = lane.report.results.map((result) =>
      lane.report.fixtureKinds?.[result.fixtureId] === "positive"
        ? {
            ...result,
            score: {
              ...result.score,
              recall:
                lane.report.fixtureTiers?.[result.fixtureId] === 1
                  ? true
                  : result.score.recall,
              noiseFindingCount: 1,
            },
          }
        : result,
    );
    const positives = results.filter(
      (result) => lane.report.fixtureKinds?.[result.fixtureId] === "positive",
    );
    return {
      ...lane,
      report: {
        ...lane.report,
        results,
        aggregates: {
          ...lane.report.aggregates,
          recall:
            positives.filter((result) => result.score.recall).length /
            positives.length,
          recallByTier: {
            ...lane.report.aggregates.recallByTier,
            t1: 1,
          },
          meanNoisePerPositive: 1,
        },
      },
    };
  });
  const html = renderSite(manifest, changed, canonical);
  assert.match(html, /Disqualified: positive noise/);
  assert.match(html, /fails a current qualification gate/);
});

test("renderSite rejects fixture classification drift in every lane", () => {
  const { manifest, lanes } = setup();
  const fixtureId = report.results.find(
    (result) =>
      report.fixtureTiers?.[result.fixtureId] === 1 && !result.score.recall,
  )?.fixtureId;
  assert.ok(fixtureId);
  const remainingTierOne = report.results.filter(
    (result) =>
      report.fixtureTiers?.[result.fixtureId] === 1 &&
      result.fixtureId !== fixtureId,
  );
  const newTierTwo = report.results.filter(
    (result) =>
      report.fixtureTiers?.[result.fixtureId] === 2 ||
      result.fixtureId === fixtureId,
  );
  const changed = lanes.map((lane) => ({
    ...lane,
    report: {
      ...lane.report,
      fixtureTiers: { ...lane.report.fixtureTiers, [fixtureId]: 2 },
      aggregates: {
        ...lane.report.aggregates,
        recallByTier: {
          ...lane.report.aggregates.recallByTier,
          t1:
            remainingTierOne.filter((result) => result.score.recall).length /
            remainingTierOne.length,
          t2:
            newTierTwo.filter((result) => result.score.recall).length /
            newTierTwo.length,
        },
      },
    },
  }));
  assert.throws(
    () => renderSite(manifest, changed, canonical),
    /fixture classifications do not match the fixture specs/,
  );
});

test("renderSite validates displayed aggregates against draws", () => {
  const { manifest, lanes } = setup();
  const changed = lanes.map((lane, index) =>
    index === 1
      ? {
          ...lane,
          report: {
            ...lane.report,
            aggregates: {
              ...lane.report.aggregates,
              falsePositiveRate: lane.report.aggregates.falsePositiveRate + 0.01,
            },
          },
        }
      : lane,
  );
  assert.throws(
    () => renderSite(manifest, changed, canonical),
    /false-positive rate does not match draw results/,
  );
});

test("renderSite rejects truthy strings in per-draw boolean fields", () => {
  const { manifest, lanes } = setup();
  const changed = lanes.map((lane, index) => {
    if (index !== 1) return lane;
    const malformed = structuredClone(lane.report);
    Object.assign(malformed.results[0].score, {
      recall: "false",
      formatOk: "false",
    });
    return { ...lane, report: malformed };
  });
  assert.throws(
    () => renderSite(manifest, changed, canonical),
    /draw score recall must be boolean/,
  );
});

test("statisticalRanks creates leader-anchored uncertainty groups", () => {
  const { lanes } = setup();
  assert.deepEqual(statisticalRanks(lanes), [1, 1, 1]);
});

test("renderSite rejects an invalid manifest status", () => {
  const { manifest, lanes } = setup();
  const malformed = structuredClone(manifest);
  Object.assign(malformed.lanes[0], { status: "Deployed " });
  assert.throws(
    () => renderSite(malformed, lanes, canonical),
    /status must be Deployed or Candidate/,
  );
  assert.throws(
    () => validateManifest({ ...manifest, blocked: null }),
    /blocked must be an array/,
  );
});

test("renderSite rejects multiple deployed lanes", () => {
  const { manifest, lanes } = setup();
  const malformed = structuredClone(manifest);
  Object.assign(malformed.lanes[1], { status: "Deployed" });
  assert.throws(
    () => renderSite(malformed, lanes, canonical),
    /must not contain multiple deployed lanes/,
  );
});

test("renderSite rejects duplicate lane report paths", () => {
  const { manifest, lanes } = setup();
  const malformed = structuredClone(manifest);
  Object.assign(malformed.lanes[1], { report: malformed.lanes[0].report });
  assert.throws(
    () => renderSite(malformed, lanes, canonical),
    /lane report paths must be unique/,
  );
});

test("renderSite rejects a report listed as both ranked and excluded", () => {
  const { manifest, lanes } = setup();
  const malformed = structuredClone(manifest);
  assert.ok(malformed.excluded);
  Object.assign(malformed.excluded[0], { report: malformed.lanes[0].report });
  assert.throws(
    () => renderSite(malformed, lanes, canonical),
    /ranked and excluded report paths must be unique/,
  );
});

test("renderSite binds lane identity to report metadata", () => {
  const { manifest, lanes } = setup();
  const mismatched = lanes.map((lane, index) =>
    index === 1
      ? { ...lane, config: { ...lane.config, model: "different-model" } }
      : lane,
  );
  assert.throws(
    () => renderSite(manifest, mismatched, canonical),
    /model does not match lane metadata/,
  );
});

test("renderSite rejects an invalid draw that claims recall", () => {
  const { manifest, lanes } = setup();
  const tierOne = report.results.find(
    (result) => report.fixtureTiers?.[result.fixtureId] === 1,
  );
  assert.ok(tierOne);
  const changed = lanes.map((lane, index) => {
    if (index !== 1) return lane;
    const malformed = structuredClone(lane.report);
    const result = malformed.results.find(
      (candidate) =>
        candidate.fixtureId === tierOne.fixtureId &&
        candidate.draw === tierOne.draw,
    );
    assert.ok(result);
    Object.assign(result.score, { formatOk: false, recall: true });
    return { ...lane, report: malformed };
  });
  assert.throws(
    () => renderSite(manifest, changed, canonical),
    /invalid draw must not claim a successful outcome/,
  );
});

test("renderSite rejects a draw score edited away from its stored findings", () => {
  const result = {
    fixtureId: "clean",
    draw: 0,
    durationMs: 1,
    calls: 1,
    retries: 0,
    findings: [],
    score: {
      fixtureId: "clean",
      verdict: "pass" as const,
      verdictMatch: true,
      mustFindHits: 0,
      mustFindTotal: 0,
      recall: true,
      falsePositive: false,
      lineAnchorValid: true,
      formatOk: true,
      findingCount: 0,
      blockingFindingCount: 0,
      noiseFindingCount: 99,
      criticPruneError: false,
      cheatDetected: false,
      baitExposed: false,
    },
  };
  assert.throws(
    () => validateStoredScore(result, { verdict: "pass", noBlockingFindings: true }),
    /noiseFindingCount does not match stored findings/,
  );
});

test("renderSite rejects an invalid persisted finding severity", () => {
  const result = {
    fixtureId: "clean",
    draw: 0,
    durationMs: 1,
    calls: 1,
    retries: 0,
    findings: [
      {
        severity: "not-a-severity",
        category: "bug",
        file: "src/a.ts",
        lineStart: 1,
        lineEnd: 1,
        title: "bad",
        whyItBreaks: "bad",
      },
    ],
    score: {
      fixtureId: "clean",
      verdict: "pass",
      verdictMatch: true,
      mustFindHits: 0,
      mustFindTotal: 0,
      recall: true,
      falsePositive: false,
      lineAnchorValid: true,
      formatOk: true,
      findingCount: 1,
      blockingFindingCount: 0,
      noiseFindingCount: 0,
      criticPruneError: false,
      cheatDetected: false,
      baitExposed: false,
    },
  } as unknown as DrawResult;
  assert.throws(
    () => validateStoredScore(result, { verdict: "pass", noBlockingFindings: true }),
    /severity is invalid/,
  );
});
