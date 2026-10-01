import { test } from "node:test";
import assert from "node:assert/strict";
import {
	acceptance,
	buildCalibration,
	coreFixtureIds,
	paretoFrontier,
	reportAdmissionError,
	scoreLane,
	type LaneScore,
} from "./calibration";
import { scorerHash } from "./scorer-hash";
import type { DrawResult, MatchEvidence, Report } from "./types";

// Per fixture: [mustFindHits per draw], mustFindTotal, optional candidate hits.
type Plan = Record<string, { hits: number[]; total: number; candidate?: number[] }>;

function evidence(total: number, hits: number): MatchEvidence[] {
	return Array.from({ length: total }, (_, i) => ({
		pattern: "x",
		findingIndex: i < hits ? i : null,
	}));
}

function lane(model: string, plan: Plan, extra: Partial<Report> = {}): Report {
	const results: DrawResult[] = [];
	let pruned = 0;
	for (const [fixtureId, { hits, total, candidate }] of Object.entries(plan)) {
		hits.forEach((h, draw) => {
			const cand = candidate?.[draw] ?? h;
			pruned += Math.max(0, cand - h);
			results.push({
				fixtureId,
				draw,
				durationMs: 1000,
				calls: 2,
				retries: 0,
				matchEvidence: evidence(total, h),
				candidateMatchEvidence: evidence(total, cand),
				score: {
					fixtureId,
					verdict: "changes_requested",
					verdictMatch: true,
					mustFindHits: h,
					mustFindTotal: total,
					recall: h === total,
					falsePositive: false,
					lineAnchorValid: true,
					formatOk: true,
					findingCount: h,
					blockingFindingCount: h,
					noiseFindingCount: 0,
					criticPruneError: cand > h,
					cheatDetected: false,
					baitExposed: false,
				},
			});
		});
	}
	return {
		promptHash: "p1",
		runner: "codex",
		model,
		effort: "high",
		draws: 3,
		createdAt: "2026-09-30T00:00:00.000Z",
		baseline: false,
		holdout: "include",
		fixtures: Object.keys(plan),
		fixtureTiers: { easy: 1, mid: 2, hard: 3, multi: 3 },
		results,
		fixtureSetHash: "f1",
		scorerHash: scorerHash(),
		anticheatVersion: 2,
		aggregates: {
			recall: 0,
			falsePositiveRate: 0,
			invalidJsonRate: 0,
			verdictMatchRate: 1,
			lineAnchorValidRate: 1,
			meanDurationMs: 1000,
			recallByFixture: {},
			criticPruneErrorRate: 0,
			recallByTier: {},
			meanNoisePerPositive: 0,
			cheatDetectedCount: 0,
			baitExposureCount: 0,
			criticPrunedRecallCount: pruned,
		},
		...extra,
	};
}

function zoo(): Report[] {
	const base = (hard: number[], mid: number[], multi: number[]): Plan => ({
		easy: { hits: [1, 1, 1], total: 1 },
		mid: { hits: mid, total: 1 },
		hard: { hits: hard, total: 1 },
		multi: { hits: multi, total: 2 },
	});
	return [
		lane("strong", base([1, 1, 0], [1, 1, 1], [2, 1, 1])),
		lane("good", base([0, 1, 0], [1, 1, 1], [1, 1, 1])),
		lane("mid", base([0, 0, 0], [1, 1, 0], [1, 1, 0])),
		lane("weak", base([0, 0, 0], [1, 0, 0], [0, 1, 0])),
		lane("floor", base([0, 0, 0], [0, 0, 0], [0, 0, 0])),
	];
}

test("buildCalibration: saturated fixtures fall into the regression layer", () => {
	const calibration = buildCalibration(zoo());
	assert.equal(calibration.fixtures.easy.layer, "regression");
	assert.equal(calibration.fixtures.easy.difficulty, 0);
	assert.equal(calibration.fixtures.hard.layer, "discriminating");
	assert.ok(calibration.fixtures.hard.difficulty > calibration.fixtures.mid.difficulty);
	assert.ok((calibration.fixtures.hard.discrimination ?? 0) > 0);
});

test("buildCalibration: refuses mixed contracts, void reports, and small zoos", () => {
	const lanes = zoo();
	assert.throws(
		() => buildCalibration([...lanes.slice(1), { ...lanes[0], promptHash: "p2" }]),
		/promptHash differs/,
	);
	assert.throws(
		() => buildCalibration([...lanes.slice(1), { ...lanes[0], fixtureSetHash: "f2" }]),
		/fixtureSetHash differs/,
	);
	assert.throws(() => buildCalibration(lanes.slice(0, 4)), /at least 5/);
	const cheat = {
		...lanes[0],
		aggregates: { ...lanes[0].aggregates, cheatDetectedCount: 1 },
	};
	assert.match(reportAdmissionError(cheat) ?? "", /void|account/);
	assert.throws(() => buildCalibration([cheat, ...lanes.slice(1)]));
	const partial = { ...lanes[0], results: lanes[0].results.slice(1) };
	assert.match(reportAdmissionError(partial) ?? "", /incomplete/);
});

test("scoreLane: partial credit counts one of two defects as half", () => {
	const calibration = buildCalibration(zoo());
	const plan: Plan = {
		easy: { hits: [1, 1, 1], total: 1 },
		mid: { hits: [1, 1, 1], total: 1 },
		hard: { hits: [0, 0, 0], total: 1 },
		multi: { hits: [1, 1, 1], total: 2 },
	};
	const score = scoreLane(calibration, lane("probe", plan));
	assert.equal(score.leaveOneOut, false);
	assert.equal(score.binaryRecall, 0.5);
	assert.equal(score.partialRecall, (1 + 1 + 0 + 0.5) / 4);
});

test("scoreLane: difficulty weighting separates lanes binary recall ties", () => {
	const calibration = buildCalibration(zoo());
	const hardSolver = lane("hard-solver", {
		easy: { hits: [1, 1, 1], total: 1 },
		mid: { hits: [0, 0, 0], total: 1 },
		hard: { hits: [1, 1, 1], total: 1 },
		multi: { hits: [0, 0, 0], total: 2 },
	});
	const easySolver = lane("easy-solver", {
		easy: { hits: [1, 1, 1], total: 1 },
		mid: { hits: [1, 1, 1], total: 1 },
		hard: { hits: [0, 0, 0], total: 1 },
		multi: { hits: [0, 0, 0], total: 2 },
	});
	const a = scoreLane(calibration, hardSolver);
	const b = scoreLane(calibration, easySolver);
	assert.equal(a.binaryRecall, b.binaryRecall);
	assert.ok(a.weightedRecall > b.weightedRecall);
});

test("scoreLane: a calibration lane is scored leave-one-out", () => {
	const lanes = zoo();
	const calibration = buildCalibration(lanes);
	const score = scoreLane(calibration, lanes[0]);
	assert.equal(score.leaveOneOut, true);
	// With itself excluded, "hard" is solved by only one other lane's draw.
	assert.ok(score.weightedRecall > 0 && score.weightedRecall < 1);
});

test("scoreLane: separates reviewer recall from critic retention", () => {
	const calibration = buildCalibration(zoo());
	const pruner = lane("pruner", {
		easy: { hits: [1, 1, 0], total: 1, candidate: [1, 1, 1] },
		mid: { hits: [0, 0, 0], total: 1, candidate: [1, 1, 1] },
		hard: { hits: [0, 0, 0], total: 1 },
		multi: { hits: [2, 2, 2], total: 2 },
	});
	const score = scoreLane(calibration, pruner);
	// candidate hits: easy 3 + mid 3 + hard 0 + multi 6 = 12 of 15 specs
	assert.equal(score.reviewerRecall, 12 / 15);
	// kept: easy 2 + multi 6 = 8 of 12
	assert.equal(score.criticRetention, 8 / 12);
});

test("scoreLane: refuses a report from another fixture set", () => {
	const calibration = buildCalibration(zoo());
	assert.throws(
		() => scoreLane(calibration, { ...zoo()[0], fixtureSetHash: "f9" }),
		/does not match calibration/,
	);
});

test("acceptance: core = saturated plus Tier-1; misses carry their stage", () => {
	const calibration = buildCalibration(zoo());
	assert.deepEqual(coreFixtureIds(calibration), ["easy"]);
	const clean = acceptance(calibration, lane("clean", {
		easy: { hits: [1, 1, 1], total: 1 },
		mid: { hits: [0, 0, 0], total: 1 },
		hard: { hits: [0, 0, 0], total: 1 },
		multi: { hits: [0, 0, 0], total: 2 },
	}));
	assert.equal(clean.passed, true, "edge-case misses do not fail acceptance");
	const pruned = acceptance(calibration, lane("pruned", {
		easy: { hits: [1, 0, 1], total: 1, candidate: [1, 1, 1] },
		mid: { hits: [1, 1, 1], total: 1 },
		hard: { hits: [1, 1, 1], total: 1 },
		multi: { hits: [2, 2, 2], total: 2 },
	}));
	assert.equal(pruned.passed, false);
	assert.deepEqual(pruned.coreMisses, [{ fixtureId: "easy", draw: 1, cause: "critic" }]);
});

test("acceptance: false positives pool up to the allowance; subset and short runs refuse", () => {
	const calibration = buildCalibration(zoo());
	const base = lane("fp", { easy: { hits: [1, 1, 1], total: 1 } });
	const negative: DrawResult = {
		...base.results[0],
		fixtureId: "clean-negative",
		score: { ...base.results[0].score, fixtureId: "clean-negative", mustFindHits: 0, mustFindTotal: 0, recall: false, falsePositive: true },
		matchEvidence: [],
		candidateMatchEvidence: [],
	};
	const withNegative = { ...base, fixtures: ["easy", "clean-negative"], draws: 3, results: [...base.results, { ...negative, draw: 0 }, { ...negative, draw: 1, score: { ...negative.score, falsePositive: false } }, { ...negative, draw: 2, score: { ...negative.score, falsePositive: false } }] };
	const result = acceptance(calibration, withNegative);
	assert.equal(result.passed, true, "one pooled false positive is within the allowance");
	assert.deepEqual(result.falsePositives, [{ fixtureId: "clean-negative", draw: 0 }]);
	const allFp = acceptance(calibration, {
		...withNegative,
		results: [...base.results, ...[0, 1, 2].map((draw) => ({ ...negative, draw }))],
	});
	assert.equal(allFp.passed, false, "three pooled false positives exceed the allowance");
	assert.throws(
		() => acceptance(calibration, { ...withNegative, draws: 1, results: [base.results[0], { ...negative, draw: 0 }] }),
		/draws 1 < 3/,
	);
	const malformed = acceptance(calibration, {
		...withNegative,
		results: [...base.results, ...[0, 1, 2].map((draw) => ({ ...negative, draw, score: { ...negative.score, falsePositive: false, formatOk: draw !== 1 } }))],
	});
	assert.equal(malformed.passed, false, "unusable negative output is not a clean pass");
	assert.deepEqual(malformed.falsePositives, []);
	assert.deepEqual(malformed.invalidNegatives, [{ fixtureId: "clean-negative", draw: 1 }]);
	assert.throws(
		() => acceptance(calibration, { ...withNegative, invocation: "node --import tsx eval/run.ts --fixtures '^easy$' --report r.json" }),
		/--fixtures subset run/,
	);
	assert.throws(() => acceptance(calibration, { ...withNegative, holdout: "exclude" }), /subset run/);
	assert.equal(
		acceptance(calibration, { ...withNegative, invocation: "node --import tsx eval/run.ts --draws 3 --report r.json" }).passed,
		true,
		"a full run is admitted",
	);
	const noCore = lane("no-core", { mid: { hits: [1, 1, 1], total: 1 } });
	assert.throws(() => acceptance(calibration, noCore), /missing core fixtures easy/);
});

test("paretoFrontier: keeps lanes no other lane beats on recall and time", () => {
	const s = (lane: string, weightedRecall: number, meanSecondsPerDraw: number) =>
		({ lane, weightedRecall, meanSecondsPerDraw }) as LaneScore;
	const frontier = paretoFrontier([s("fast", 0.6, 30), s("best", 0.9, 200), s("dominated", 0.5, 100)]);
	assert.deepEqual([...frontier].sort(), ["best", "fast"]);
});
