import { test } from "node:test";
import assert from "node:assert/strict";
import { compareWeekly } from "./weekly-compare";
import type { Aggregates, DrawResult, FixtureScore, Report } from "./shared/types";

function scoreOf(partial: Partial<FixtureScore> & Pick<FixtureScore, "fixtureId">): FixtureScore {
  return {
    verdict: "pass",
    verdictMatch: true,
    mustFindHits: 0,
    mustFindTotal: 0,
    recall: true,
    falsePositive: false,
    lineAnchorValid: true,
    formatOk: true,
    findingCount: 0,
    blockingFindingCount: 0,
    noiseFindingCount: 0,
    criticPruneError: false,
    cheatDetected: false,
    ...partial,
  };
}

function draw(fixtureId: string, drawNo: number, partial: Partial<FixtureScore>): DrawResult {
  return { fixtureId, draw: drawNo, score: scoreOf({ fixtureId, ...partial }), durationMs: 0, calls: 1, retries: 0 };
}

function aggregatesOf(partial: Partial<Aggregates>): Aggregates {
  return {
    recall: 1,
    falsePositiveRate: 0,
    invalidJsonRate: 0,
    verdictMatchRate: 1,
    lineAnchorValidRate: 1,
    meanDurationMs: 0,
    recallByFixture: {},
    criticPruneErrorRate: 0,
    recallByTier: {},
    meanNoisePerPositive: 0,
    cheatDetectedCount: 0,
    ...partial,
  };
}

function report(results: DrawResult[], partial: Partial<Report> = {}): Report {
  return {
    promptHash: "abc",
    runner: "codex",
    model: null,
    effort: null,
    draws: 3,
    createdAt: "2026-07-09T00:00:00.000Z",
    baseline: false,
    holdout: "include",
    results,
    aggregates: aggregatesOf(partial.aggregates ? { ...partial.aggregates } : {}),
    fixtureSetHash: "fff",
    fixtureTiers: {},
    ...partial,
  };
}

function drawsFor(fixtureId: string, recalls: boolean[], fp = false): DrawResult[] {
  return recalls.map((r, i) => draw(fixtureId, i, { recall: r, falsePositive: fp }));
}

test("compareWeekly: no alert when everything stable", () => {
  const prev = report([...drawsFor("a", [true, true, true]), ...drawsFor("b", [true, true, true])]);
  const latest = report([...drawsFor("a", [true, true, true]), ...drawsFor("b", [true, true, true])]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false);
});

test("compareWeekly: single mixed-draw flicker does NOT alert", () => {
  const prev = report([...drawsFor("a", [true, true, true]), ...drawsFor("b", [true, true, true])]);
  const latest = report([...drawsFor("a", [true, false, true]), ...drawsFor("b", [true, true, true])]);
  assert.equal(compareWeekly(prev, latest).alert, false, "mixed draws are variance, not regression");
});

test("compareWeekly: one stable non-t1 regression does NOT alert; two do", () => {
  const prev = report([
    ...drawsFor("a", [true, true, true]),
    ...drawsFor("b", [true, true, true]),
    ...drawsFor("c", [true, true, true]),
  ]);
  const one = report([
    ...drawsFor("a", [false, false, false]),
    ...drawsFor("b", [true, true, true]),
    ...drawsFor("c", [true, true, true]),
  ]);
  const two = report([
    ...drawsFor("a", [false, false, false]),
    ...drawsFor("b", [false, false, false]),
    ...drawsFor("c", [true, true, true]),
  ]);
  assert.equal(compareWeekly(prev, one).alert, false);
  assert.equal(compareWeekly(prev, two).alert, true);
});

test("compareWeekly: a single tier-1 stable regression alerts", () => {
  const prev = report([...drawsFor("t1-fix", [true, true, true]), ...drawsFor("b", [true, true, true])]);
  const latest = report([...drawsFor("t1-fix", [false, false, false]), ...drawsFor("b", [true, true, true])], {
    fixtureTiers: { "t1-fix": 1, b: 2 },
  });
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true);
  assert.ok(v.reasons.some((r) => r.includes("tier-1")));
});

test("compareWeekly: tier-1 stable miss alerts even with no previous report", () => {
  const latest = report([...drawsFor("t1-fix", [false, false, false]), ...drawsFor("b", [true, true, true])], {
    fixtureTiers: { "t1-fix": 1, b: 2 },
  });
  const v = compareWeekly(null, latest);
  assert.equal(v.alert, true, "first run must still page on a stably missed tier-1 fixture");
  assert.ok(v.reasons.some((r) => r.includes("tier-1")));
});

test("compareWeekly: tier-1 stable miss alerts across a prompt/fixture change", () => {
  const prev = report([...drawsFor("t1-fix", [true, true, true])], { promptHash: "old" });
  const latest = report([...drawsFor("t1-fix", [false, false, false])], { fixtureTiers: { "t1-fix": 1 } });
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true, "hash change skips regression deltas but not the tier-1 floor");
});

test("compareWeekly: new stable false positive alerts", () => {
  const prev = report([...drawsFor("neg-x", [true, true, true], false)]);
  const latest = report([...drawsFor("neg-x", [true, true, true], true)]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true);
  assert.ok(v.reasons.some((r) => r.includes("false positive")));
});

test("compareWeekly: cheat detection alerts even without a previous report", () => {
  const latest = report([], { aggregates: aggregatesOf({ cheatDetectedCount: 2 }) });
  const v = compareWeekly(null, latest);
  assert.equal(v.alert, true);
  assert.ok(v.reasons.some((r) => r.includes("CHEAT")));
});

test("compareWeekly: prompt change skips regression comparison but keeps cheat alert", () => {
  const prev = report([...drawsFor("a", [true, true, true])], { promptHash: "old" });
  const latest = report([...drawsFor("a", [false, false, false])]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false, "regression across prompt change is not comparable");
  assert.ok(v.reasons.some((r) => r.includes("prompt/fixture set changed")));
});
