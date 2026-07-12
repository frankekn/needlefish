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
    anticheatVersion: 1,
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
  assert.ok(
    v.reasons.some((r) => r.includes("prompt/fixture set/anti-cheat generation changed")),
  );
});

test("compareWeekly: a compromised previous week skips regression comparison", () => {
  // Matching hashes and guard generation, but the previous week's trap fired:
  // its numbers are void and must not produce regression conclusions.
  const prev = report([...drawsFor("a", [true, true, true])], {
    aggregates: aggregatesOf({ cheatDetectedCount: 1 }),
  });
  const latest = report([...drawsFor("a", [false, false, false])]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false, "void baseline must not alert");
  assert.ok(
    v.reasons.some((r) => r.includes("compromised report")),
  );
});

test("compareWeekly: a compromised latest week alerts CHEAT and withholds every other metric", () => {
  const prev = report([...drawsFor("a", [true, true, true])]);
  // Compromised latest ALSO carries a high invalid-JSON rate and a stable
  // tier-1 miss — none of which may surface: void numbers produce no
  // conclusions of any kind.
  const latest = report([...drawsFor("t1-fix", [false, false, false])], {
    aggregates: aggregatesOf({ cheatDetectedCount: 1, invalidJsonRate: 0.5 }),
    fixtureTiers: { "t1-fix": 1 },
  });
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true, "CHEAT on the latest report must alert");
  assert.ok(v.reasons.some((r) => r.includes("CHEAT")));
  const substantive = v.reasons.filter((r) => !r.startsWith("note:"));
  assert.equal(
    substantive.length,
    1,
    `CHEAT must be the only substantive reason, got: ${v.reasons.join(" | ")}`,
  );
});

test("compareWeekly: a pre-guard previous week skips regression comparison", () => {
  // Same prompt/fixture hashes, but the previous report predates the
  // anti-cheat guards — its draws are declared incomparable.
  const prev = report([...drawsFor("a", [true, true, true])], {
    anticheatVersion: undefined,
  });
  const latest = report([...drawsFor("a", [false, false, false])]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false, "cross-generation regression must not alert");
  assert.ok(
    v.reasons.some((r) => r.includes("anti-cheat generation changed")),
  );
});

for (const [name, prevHash, latestHash] of [
  ["previous hash missing", undefined, "fff"],
  ["latest hash missing", "fff", undefined],
  ["fixture hashes empty", "", ""],
] as const) {
  test(`compareWeekly: ${name} skips week-over-week comparison`, () => {
    const prev = report([...drawsFor("a", [true, true, true]), ...drawsFor("b", [true, true, true])], {
      fixtureSetHash: prevHash,
    });
    const latest = report([...drawsFor("a", [false, false, false]), ...drawsFor("b", [false, false, false])], {
      fixtureSetHash: latestHash,
    });
    const v = compareWeekly(prev, latest);
    assert.equal(v.alert, false, "incomparable reports must not emit a regression alert");
    assert.ok(v.reasons.some((r) => r.includes("skipping regression comparison")));
    assert.ok(v.reasons.every((r) => !r.includes("fixtures regressed")));
  });
}

test("compareWeekly: latest-only checks still alert when a fixture hash is missing", () => {
  const prev = report(drawsFor("t1-fix", [true, true, true]), { fixtureSetHash: undefined });
  const latest = report(drawsFor("t1-fix", [false, false, false]), { fixtureTiers: { "t1-fix": 1 } });
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true);
  assert.ok(v.reasons.some((r) => r.includes("tier-1")));
  assert.ok(v.reasons.some((r) => r.includes("skipping regression comparison")));
});
