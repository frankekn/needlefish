import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding } from "../../src/shared/schema";
import type { RunStat } from "../../src/shared/runner";
import {
	criticDrawFields,
	criticValueAggregates,
	formatCriticValue,
} from "./critic-value";
import { score } from "./score";
import type { Expected, FixtureSpec } from "./types";

function finding(
	partial: Partial<Finding> &
		Pick<Finding, "title" | "whyItBreaks" | "file" | "lineStart">,
): Finding {
	return {
		severity: "P1",
		category: "bug",
		lineEnd: partial.lineStart,
		confidence: 0.8,
		suggestedFix: "",
		validation: "",
		...partial,
	};
}

function stat(label: string, durationMs: number): RunStat {
	return { label, runner: "codex", durationMs, attempts: 1, ok: true };
}

const positive: Expected = {
	verdict: "changes_requested",
	anchorFile: "src/cache.ts",
	mustFind: [{ pattern: "stale entry" }],
};
const negative: Expected = { verdict: "pass", noBlockingFindings: true };
const specs: Pick<FixtureSpec, "id" | "kind">[] = [
	{ id: "pos", kind: "positive" },
	{ id: "neg", kind: "negative" },
];

const hit = finding({
	title: "stale entry served after invalidation",
	whyItBreaks: "readers see the old value",
	file: "src/cache.ts",
	lineStart: 10,
});
const noise = finding({
	title: "possible race in logger",
	whyItBreaks: "speculative",
	file: "src/log.ts",
	lineStart: 3,
});

function draw(
	fixtureId: string,
	expected: Expected,
	final: readonly Finding[],
	candidateFindings?: readonly Finding[],
	stats?: RunStat[],
) {
	const result = {
		verdict: "changes_requested" as const,
		findings: final,
		...(candidateFindings ? { candidateFindings } : {}),
		...(stats ? { stats } : {}),
	};
	return {
		fixtureId,
		score: score(result, expected, fixtureId),
		...criticDrawFields(result, expected, fixtureId),
	};
}

test("critic value: pruning a noise finding lowers noise against the candidate", () => {
	const pruned = draw("pos", positive, [hit], [hit, noise]);
	assert.equal(pruned.candidateScore?.noiseFindingCount, 1);
	assert.equal(pruned.candidateScore?.findingCount, 2);
	assert.equal(pruned.candidateScore?.blockingFindingCount, 2);
	assert.equal(pruned.score.noiseFindingCount, 0);

	const aggregates = criticValueAggregates([pruned], specs);
	assert.equal(aggregates.candidateMeanNoisePerPositive, 1);
	assert.equal(aggregates.criticDelta?.meanNoisePerPositive, -1);
	assert.equal(aggregates.criticDelta?.recall, 0);
	assert.equal(aggregates.criticDelta?.falsePositiveRate, undefined);
});

test("critic value: pruning a true positive shows as a negative recall delta", () => {
	const pruned = draw("pos", positive, [], [hit]);
	assert.equal(pruned.candidateScore?.recall, true);
	assert.equal(pruned.score.recall, false);

	const aggregates = criticValueAggregates([pruned], specs);
	assert.equal(aggregates.criticDelta?.recall, -1);
	assert.equal(aggregates.criticDelta?.meanNoisePerPositive, 0);
});

test("critic value: pruning a blocking finding on a negative lowers the false-positive rate", () => {
	const pruned = draw("neg", negative, [], [noise]);
	assert.equal(pruned.candidateScore?.falsePositive, true);
	assert.equal(pruned.score.falsePositive, false);

	const aggregates = criticValueAggregates([pruned], specs);
	assert.equal(aggregates.candidateFalsePositiveRate, 1);
	assert.equal(aggregates.criticDelta?.falsePositiveRate, -1);
	assert.equal(aggregates.candidateMeanNoisePerPositive, undefined);
});

test("critic value: a draw without candidateFindings or stats carries no fields, not zeros", () => {
	const legacy = draw("pos", positive, [hit]);
	assert.equal("candidateScore" in legacy, false);
	assert.equal("criticMs" in legacy, false);
	assert.equal("totalPassMs" in legacy, false);
	assert.deepEqual(criticDrawFields(null, positive, "pos"), {});

	assert.deepEqual(criticValueAggregates([legacy], specs), {});
	assert.equal(formatCriticValue({}), null);
});

test("critic value: deltas pair only draws that carry a candidate score", () => {
	const legacyMiss = draw("pos", positive, []);
	const traced = draw("pos", positive, [hit], [hit, noise]);
	const aggregates = criticValueAggregates([legacyMiss, traced], specs);
	assert.equal(aggregates.criticDelta?.recall, 0);
	assert.equal(aggregates.candidateMeanNoisePerPositive, 1);
});

test("critic value: time share sums critic stats over all pass stats", () => {
	const timed = draw("pos", positive, [hit], [hit], [
		stat("map", 100),
		stat("deep:auth", 300),
		stat("deep:cache", 200),
		stat("critic", 150),
		stat("critic", 250),
	]);
	assert.equal(timed.criticMs, 400);
	assert.equal(timed.totalPassMs, 1000);

	const untimed = draw("pos", positive, [hit], [hit]);
	const aggregates = criticValueAggregates([timed, untimed], specs);
	assert.equal(aggregates.criticTimeShare, 0.4);
});

test("critic value: summary block names each available measure", () => {
	const block = formatCriticValue({
		candidateFalsePositiveRate: 0.5,
		candidateMeanNoisePerPositive: 1.25,
		criticDelta: { falsePositiveRate: -0.25, meanNoisePerPositive: -0.75, recall: -0.1 },
		criticTimeShare: 0.3,
	});
	assert.equal(
		block,
		[
			"Critic value",
			"  candidate falsePositiveRate:    50.0% (critic Δ -25.0%)",
			"  candidate meanNoisePerPositive: 1.25 (critic Δ -0.75)",
			"  critic Δ recall:                -10.0%",
			"  critic share of pass time:      30.0%",
		].join("\n"),
	);
});
