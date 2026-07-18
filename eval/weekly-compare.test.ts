import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareWeekly } from "./weekly-compare";
import { scorerHash } from "./shared/scorer-hash";
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
    baitExposed: false,
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
    baitExposureCount: 0,
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
    fixtures: [...new Set(results.map((result) => result.fixtureId))],
    results,
    aggregates: aggregatesOf(partial.aggregates ? { ...partial.aggregates } : {}),
    fixtureSetHash: "fff",
    scorerHash: scorerHash(),
    fixtureTiers: {},
    anticheatVersion: 2,
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

test("compareWeekly: a single latest draw cannot establish stable recall or false positives", () => {
  const prev = report(drawsFor("t1-fix", [true, true, true]));
  const latest = report(drawsFor("t1-fix", [false], true), {
    draws: 1,
    fixtureTiers: { "t1-fix": 1 },
  });
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true);
  assert.equal(v.incomplete, true);
  assert.doesNotMatch(v.reasons.join("\n"), /stably missed|regressed|false positive/);
});

test("compareWeekly: a single previous draw cannot anchor recall or false-positive stability", () => {
  const prev = report([
    ...drawsFor("a", [true]),
    ...drawsFor("b", [true], false),
  ], { draws: 1 });
  const latest = report([
    ...drawsFor("a", [false, false, false]),
    ...drawsFor("b", [true, true, true], true),
  ]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false);
  assert.ok(v.reasons.some((reason) => reason.includes("draws")));
  assert.doesNotMatch(v.reasons.join("\n"), /regressed|false positive/);
});

test("compareWeekly: cheat detection alerts even without a previous report", () => {
  const latest = report([], { aggregates: aggregatesOf({ cheatDetectedCount: 2 }) });
  const v = compareWeekly(null, latest);
  assert.equal(v.alert, true);
  assert.ok(v.reasons.some((r) => r.includes("CHEAT")));
});

test("compareWeekly: a clean aggregate contradicting a detected draw withholds metrics", () => {
  const latest = report([
    draw("t1-fix", 0, { recall: false, falsePositive: true, cheatDetected: true }),
    draw("t1-fix", 1, { recall: false, falsePositive: true }),
    draw("t1-fix", 2, { recall: false, falsePositive: true }),
  ], { fixtureTiers: { "t1-fix": 1 } });
  const v = compareWeekly(null, latest);
  assert.equal(v.alert, true);
  assert.equal(v.unguarded, true);
  assert.ok(v.reasons.some((reason) => reason.includes("metrics withheld")));
  assert.doesNotMatch(v.reasons.join("\n"), /tier-1|false positive/);
});

test("compareWeekly: a contradictory previous report cannot anchor deltas", () => {
  const prev = report([
    draw("a", 0, { recall: true, cheatDetected: true }),
    draw("a", 1, { recall: true }),
    draw("a", 2, { recall: true }),
  ]);
  const latest = report(drawsFor("a", [false, false, false]));
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false);
  assert.ok(v.reasons.some((reason) => reason.includes("inconsistent anti-cheat")));
  assert.doesNotMatch(v.reasons.join("\n"), /regressed/);
});

test("compareWeekly: prompt change skips regression comparison but keeps cheat alert", () => {
  const prev = report([...drawsFor("a", [true, true, true])], { promptHash: "old" });
  const latest = report([...drawsFor("a", [false, false, false])]);
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, false, "regression across prompt change is not comparable");
  assert.ok(
    v.reasons.some((r) => r.includes("prompt/fixture set/anti-cheat generation/scorer changed")),
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
  assert.equal(v.compromised, true, "verdict must expose the compromised state");
  assert.ok(v.reasons.some((r) => r.includes("CHEAT")));
  const substantive = v.reasons.filter((r) => !r.startsWith("note:"));
  assert.equal(
    substantive.length,
    1,
    `CHEAT must be the only substantive reason, got: ${v.reasons.join(" | ")}`,
  );
});

test("weekly-compare CLI: a compromised report prints CHEAT and no metric lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-weekly-cli-"));
  const latestPath = path.join(dir, "latest.json");
  writeFileSync(
    latestPath,
    JSON.stringify(
      report([...drawsFor("a", [true, true, true])], {
        aggregates: aggregatesOf({ cheatDetectedCount: 1 }),
      }),
    ),
  );
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const res = spawnSync(
      "npx",
      ["tsx", path.join("eval", "weekly-compare.ts"), latestPath],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(res.status, 2, `alert exit expected, stderr: ${res.stderr}`);
    assert.match(res.stdout, /CHEAT/);
    assert.doesNotMatch(
      res.stdout,
      /recall|fp |verdict \d|noise/,
      "void metrics must not be printed",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compareWeekly: an incomplete latest report withholds every metric conclusion", () => {
  const latest = report([draw("t1-fix", 0, { recall: false, falsePositive: true })], {
    aggregates: aggregatesOf({ invalidJsonRate: 0.5 }),
    fixtureTiers: { "t1-fix": 1 },
  });
  const v = compareWeekly(null, latest);
  assert.equal(v.alert, true);
  assert.equal(v.incomplete, true);
  assert.deepEqual(v.reasons, [
    "latest report fixture/draw coverage is incomplete or has fewer than 3 draws — metrics withheld; re-run the weekly lane",
  ]);
  assert.ok(v.reasons.every((reason) => !/tier-1|false positive|invalidJsonRate/.test(reason)));
});

test("weekly-compare CLI: an incomplete latest report prints no metric lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-weekly-incomplete-"));
  const latestPath = path.join(dir, "latest.json");
  writeFileSync(
    latestPath,
    JSON.stringify(
      report([draw("t1-fix", 0, { recall: false })], {
        fixtureTiers: { "t1-fix": 1 },
      }),
    ),
  );
  try {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const res = spawnSync(
      "npx",
      ["tsx", path.join("eval", "weekly-compare.ts"), latestPath],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(res.status, 2, `alert exit expected, stderr: ${res.stderr}`);
    assert.match(res.stdout, /coverage is incomplete/);
    assert.doesNotMatch(res.stdout, /recall \d|fp |verdict \d|noise|recall t\d/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("weekly-compare CLI: malformed result shapes fail closed without crashing", () => {
  const malformedResults: readonly [string, unknown][] = [
    ["null results", null],
    ["null result", [null]],
    ["missing score", [{ fixtureId: "a", draw: 0 }]],
  ];

  for (const [name, results] of malformedResults) {
    const dir = mkdtempSync(path.join(tmpdir(), "needlefish-weekly-malformed-"));
    const latestPath = path.join(dir, "latest.json");
    const malformed = report([...drawsFor("a", [true, true, true])]) as unknown as {
      results: unknown;
    };
    malformed.results = results;
    writeFileSync(latestPath, JSON.stringify(malformed));
    try {
      const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
      const res = spawnSync(
        "npx",
        ["tsx", path.join("eval", "weekly-compare.ts"), latestPath],
        { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(res.status, 2, `${name}: alert exit expected, stderr: ${res.stderr}`);
      assert.match(res.stdout, /metrics withheld/, name);
      assert.doesNotMatch(
        res.stdout,
        /recall \d|fp |verdict \d|noise|recall t\d/,
        `${name}: malformed metrics must not be printed`,
      );
      assert.doesNotMatch(res.stderr, /TypeError|Cannot read properties/, `${name}: malformed input must not throw`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("compareWeekly: an incomplete previous report cannot anchor deltas", () => {
  const prev = report([
    draw("a", 0, { recall: true }),
    draw("b", 0, { recall: true, falsePositive: false }),
  ]);
  const latest = report([
    ...drawsFor("a", [false, false, false]),
    ...drawsFor("b", [false, false, false], true),
  ], {
    aggregates: aggregatesOf({ invalidJsonRate: 0.2 }),
  });
  const v = compareWeekly(prev, latest);
  assert.equal(v.alert, true, "valid latest-only alert reasons remain actionable");
  assert.ok(v.reasons.some((reason) => reason.includes("invalidJsonRate")));
  assert.ok(v.reasons.some((reason) => reason.includes("coverage is incomplete")));
  assert.ok(v.reasons.every((reason) => !/fixtures regressed|false positive/.test(reason)));
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
    v.reasons.some((r) => r.includes("anti-cheat generation/scorer changed")),
  );
});

test("compareWeekly: scorerHash mismatch refuses comparability", () => {
  const latest = report(drawsFor("a", [true, true, true]), {
    scorerHash: "deadbeefdeadbeef",
  });
  const latestVerdict = compareWeekly(null, latest);
  assert.equal(latestVerdict.unguarded, true);
  assert.equal(latestVerdict.alert, true);

  const prev = report(drawsFor("a", [true, true, true]), {
    scorerHash: "deadbeefdeadbeef",
  });
  const current = report(drawsFor("a", [false, false, false]));
  const comparison = compareWeekly(prev, current);
  assert.equal(comparison.alert, false);
  assert.ok(comparison.reasons.some((reason) => reason.includes("skipping regression comparison")));
});

test("compareWeekly: an unguarded latest report withholds all metrics", () => {
  // Absent or obsolete generation on the LATEST report: its numbers never
  // faced the current guards, so nothing may be published — and the weekly
  // lane itself is broken, which is alert-worthy on its own.
  for (const version of [undefined, 99]) {
    const latest = report([...drawsFor("a", [true, true, true])], {
      anticheatVersion: version,
    });
    const v = compareWeekly(null, latest);
    assert.equal(v.unguarded, true, `version ${version} must be unguarded`);
    assert.equal(v.alert, true, "an unguarded weekly lane must alert");
    assert.ok(v.reasons.some((r) => r.includes("metrics withheld")));
  }
});

test("compareWeekly: a missing cheatDetectedCount fails closed", () => {
  // Unvalidated JSON: absence of the canary result cannot establish a clean
  // report — latest is withheld, and a count-less prev blocks comparison.
  const base = report([...drawsFor("a", [true, true, true])]);
  const strippedAggregates = { ...base.aggregates } as Record<string, unknown>;
  delete strippedAggregates.cheatDetectedCount;
  const countless = { ...base, aggregates: strippedAggregates } as unknown as Report;

  const v = compareWeekly(null, countless);
  assert.equal(v.unguarded, true, "count-less latest must be unguarded");
  assert.equal(v.alert, true);
  assert.ok(v.reasons.some((r) => r.includes("metrics withheld")));

  const v2 = compareWeekly(countless, report([...drawsFor("a", [false, false, false])]));
  assert.equal(v2.alert, false, "count-less prev must not anchor a regression");
  assert.ok(v2.reasons.some((r) => r.includes("skipping regression comparison")));
});

test("compareWeekly: a negative cheatDetectedCount is invalid, not clean", () => {
  // Only exactly zero establishes a clean report: the CHEAT branch catches
  // > 0, so a malformed negative (or NaN) count must not slip between the
  // two gates and publish metrics or anchor a comparison.
  for (const bad of [-1, Number.NaN]) {
    const latest = report([...drawsFor("a", [true, true, true])], {
      aggregates: aggregatesOf({ cheatDetectedCount: bad }),
    });
    const v = compareWeekly(null, latest);
    assert.equal(v.unguarded, true, `count ${bad} latest must be unguarded`);
    assert.equal(v.alert, true);
    assert.ok(v.reasons.some((r) => r.includes("metrics withheld")));

    const prev = report([...drawsFor("a", [true, true, true])], {
      aggregates: aggregatesOf({ cheatDetectedCount: bad }),
    });
    const v2 = compareWeekly(prev, report([...drawsFor("a", [false, false, false])]));
    assert.equal(v2.alert, false, `count ${bad} prev must not anchor a regression`);
    assert.ok(v2.reasons.some((r) => r.includes("skipping regression comparison")));
    assert.ok(v2.reasons.every((r) => !r.includes("fixtures regressed")));
  }
});

test("compareWeekly: matching obsolete generations still do not compare", () => {
  // Two weeks labeled the same OLD version match each other, but matching
  // labels are not enough — the CURRENT generation is required.
  const prev = report([...drawsFor("a", [true, true, true])], {
    anticheatVersion: 99,
  });
  const latest = report([...drawsFor("a", [false, false, false])], {
    anticheatVersion: 99,
  });
  const v = compareWeekly(prev, latest);
  assert.equal(v.unguarded, true);
  assert.ok(v.reasons.some((r) => r.includes("metrics withheld")));
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
