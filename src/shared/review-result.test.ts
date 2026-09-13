import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewResult } from "./review-result";
import { serializeReviewResult, type ReviewResult } from "./schema";

function baseResult(): ReviewResult {
	return {
		schemaVersion: 1,
		verdict: "pass",
		summary: "All good.",
		findings: [],
		checked: ["imports"],
		residualRisks: [{ text: "untested path", blocks: false }],
		baseSha: "a".repeat(40),
		headSha: "b".repeat(40),
	};
}

function serialized(overrides: Record<string, unknown> = {}): unknown {
	return {
		...JSON.parse(serializeReviewResult(baseResult())),
		...overrides,
	};
}

test("parseReviewResult round-trips a serialized result", () => {
	const result = parseReviewResult(serialized());
	assert.deepEqual(result, baseResult());
});

test("parseReviewResult accepts every optional field by type when present", () => {
	const result = parseReviewResult(
		serialized({
			reviewTarget: "Review target: merge-base..HEAD",
			stats: [
				{
					label: "review",
					runner: "claude",
					model: "claude-x",
					durationMs: 1000,
					attempts: 2,
					ok: true,
				},
				{
					label: "critic",
					runner: "codex",
					durationMs: 500,
					attempts: 1,
					ok: false,
				},
			],
			totalDurationMs: 1600,
			coverage: "3/3 changed files deep-reviewed",
			candidateFindings: [
				{
					severity: "P3",
					title: "nit",
					category: "bug",
					file: "src/app.ts",
					lineStart: 1,
					lineEnd: 1,
					confidence: 0.5,
					whyItBreaks: "why",
					suggestedFix: "fix",
					validation: "",
				},
			],
			failedRawOutputs: ["{bad json"],
			rawOutputs: ['{"summary":"ok"}'],
			traceDeliveryFailed: true,
		}),
	);
	assert.equal(result.reviewTarget, "Review target: merge-base..HEAD");
	assert.equal(result.stats?.length, 2);
	assert.equal(result.stats?.[0].model, "claude-x");
	assert.equal(result.stats?.[1].model, undefined);
	assert.equal(result.totalDurationMs, 1600);
	assert.equal(result.coverage, "3/3 changed files deep-reviewed");
	assert.equal(result.candidateFindings?.[0].severity, "P3");
	assert.deepEqual(result.failedRawOutputs, ["{bad json"]);
	assert.deepEqual(result.rawOutputs, ['{"summary":"ok"}']);
	assert.equal(result.traceDeliveryFailed, true);
});

test("parseReviewResult ignores unknown additive fields", () => {
	const result = parseReviewResult(serialized({ futureField: { nested: 1 } }));
	assert.equal(result.verdict, "pass");
	assert.equal("futureField" in result, false);
});

test("parseReviewResult rejects wrong schemaVersion", () => {
	assert.throws(
		() => parseReviewResult(serialized({ schemaVersion: 2 })),
		/schemaVersion must be 1/,
	);
	assert.throws(
		() => parseReviewResult(serialized({ schemaVersion: "1" })),
		/schemaVersion must be 1/,
	);
});

test("parseReviewResult rejects missing or mistyped required fields", () => {
	assert.throws(() => parseReviewResult("nope"), /not an object/);
	assert.throws(() => parseReviewResult(serialized({ summary: 42 })), /summary/);
	assert.throws(() => parseReviewResult(serialized({ verdict: "lgtm" })), /invalid verdict/);
	assert.throws(() => parseReviewResult(serialized({ findings: {} })), /findings/);
	assert.throws(
		() => parseReviewResult(serialized({ checked: ["ok", 7] })),
		/checked.*non-string/,
	);
	assert.throws(
		() => parseReviewResult(serialized({ residualRisks: [{ text: "x" }] })),
		/blocks/,
	);
	assert.throws(() => parseReviewResult(serialized({ baseSha: null })), /baseSha/);
	assert.throws(() => parseReviewResult(serialized({ headSha: 1 })), /headSha/);
});

test("parseReviewResult validates findings through normalizeFinding", () => {
	assert.throws(
		() =>
			parseReviewResult(
				serialized({
					findings: [
						{
							severity: "P9",
							title: "x",
							category: "bug",
							file: "a.ts",
							lineStart: 1,
							confidence: 1,
							whyItBreaks: "w",
							suggestedFix: "f",
						},
					],
				}),
			),
		/malformed finding: invalid severity/,
	);
});

test("parseReviewResult rejects mistyped optional fields", () => {
	for (const [field, value, pattern] of [
		["reviewTarget", 5, /reviewTarget/],
		["stats", "x", /stats/],
		["stats", [{ label: "l", runner: "not-a-runner", durationMs: 1, attempts: 1, ok: true }], /runner/],
		["stats", [{ label: "l", runner: "codex", durationMs: 1, attempts: 0, ok: true }], /attempts/],
		["totalDurationMs", "1600", /totalDurationMs/],
		["coverage", null, /coverage/],
		["failedRawOutputs", ["" , 1], /failedRawOutputs/],
		["rawOutputs", "not-array", /rawOutputs/],
		["traceDeliveryFailed", "yes", /traceDeliveryFailed/],
	] as const) {
		assert.throws(() => parseReviewResult(serialized({ [field]: value })), pattern);
	}
});
