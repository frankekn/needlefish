import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFinding } from "./normalize";
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

test("parseReviewResult validates findings strictly, with no coercion", () => {
	const valid = {
		severity: "P2",
		title: "x",
		category: "bug",
		file: "a.ts",
		lineStart: 1,
		lineEnd: 2,
		confidence: 0.9,
		whyItBreaks: "w",
		suggestedFix: "f",
		validation: "",
	};
	for (const [override, pattern] of [
		// missing lineEnd — normalizeFinding would default it to lineStart
		[{ lineEnd: undefined }, /lineEnd/],
		// lowercase severity — normalizeFinding would uppercase it
		[{ severity: "p2" }, /severity invalid/],
		[{ severity: "P9" }, /severity invalid/],
		[{ category: "Bug" }, /category invalid/],
		// string confidence — normalizeFinding would coerce via Number()
		[{ confidence: "0.9" }, /confidence invalid/],
		[{ confidence: 1.5 }, /confidence invalid/],
		[{ confidence: -0.1 }, /confidence invalid/],
		// non-P3 below the persisted 0.7 gate — verdict-bearing
		[{ confidence: 0.5 }, /confidence below 0\.7/],
		[{ lineStart: "3" }, /lineStart/],
		[{ lineStart: 0 }, /lineStart/],
		[{ lineStart: -1 }, /lineStart/],
		[{ lineEnd: 1, lineStart: 5 }, /lineEnd before lineStart/],
		[{ file: "" }, /file is empty/],
		[{ title: 3 }, /title/],
		[{ validation: undefined }, /validation/],
		[{ consumerFile: "" }, /consumerFile/],
		[{ consumerLine: 0 }, /consumerLine/],
		[{ consumerLine: "x" }, /consumerLine/],
		// replacement must be rejected, not silently dropped
		[{ replacement: "x" }, /replacement not an object/],
		[{ replacement: { lines: ["a\nb"] } }, /replacement\.lines/],
		[{ replacement: { lines: [] } }, /replacement\.lines/],
		[{ replacement: { lines: [3] } }, /replacement\.lines/],
	] as const) {
		const finding = { ...valid };
		for (const [key, value] of Object.entries(override)) {
			if (value === undefined) delete (finding as Record<string, unknown>)[key];
			else (finding as Record<string, unknown>)[key] = value;
		}
		assert.throws(
			() => parseReviewResult(serialized({ findings: [finding] })),
			pattern,
			`expected rejection for ${JSON.stringify(override)}`,
		);
	}
});

test("parseReviewResult admits exactly what normalizeFinding persists", () => {
	// normalizeFinding's admission domain is the parser's acceptance domain:
	// fractional lineStart/lineEnd pass through, and consumerLine keeps any
	// non-zero finite number (fractional or negative).
	const persisted = normalizeFinding({
		severity: "P2",
		title: "x",
		category: "bug",
		file: "a.ts",
		lineStart: 1.5,
		lineEnd: 2.5,
		confidence: 0.9,
		whyItBreaks: "w",
		suggestedFix: "f",
		validation: "v",
		consumerLine: "3.5",
	});
	const negative = normalizeFinding({
		severity: "P3",
		title: "y",
		category: "bug",
		file: "b.ts",
		lineStart: 4,
		confidence: 0.5,
		whyItBreaks: "w",
		suggestedFix: "f",
		consumerLine: -2,
	});

	const result = parseReviewResult(
		serialized({ findings: [persisted, negative] }),
	);

	assert.equal(result.findings[0].lineStart, 1.5);
	assert.equal(result.findings[0].lineEnd, 2.5);
	assert.equal(result.findings[0].consumerLine, 3.5);
	assert.equal(result.findings[1].consumerLine, -2);
});

test("parseReviewResult preserves optional finding fields exactly", () => {
	const result = parseReviewResult(
		serialized({
			findings: [
				{
					severity: "P1",
					title: "breaks callers",
					category: "contract",
					file: "src/api.ts",
					lineStart: 10,
					lineEnd: 14,
					confidence: 0.95,
					whyItBreaks: "signature changed",
					suggestedFix: "keep the old parameter",
					validation: "callers in app.ts",
					consumerFile: "src/app.ts",
					consumerLine: 33,
					replacement: { lines: ["export fn(a, b) {", "  return a;"] },
				},
			],
		}),
	);
	const finding = result.findings[0];
	assert.equal(finding.consumerFile, "src/app.ts");
	assert.equal(finding.consumerLine, 33);
	assert.deepEqual(finding.replacement, { lines: ["export fn(a, b) {", "  return a;"] });
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
