import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Verdict } from "../../src/shared/schema";
import {
	fileMatchesAnchor,
	matchEvidence,
	matchesSpec,
	score,
} from "./score";
import type { Expected } from "./types";

function finding(
	partial: Partial<Finding> &
		Pick<Finding, "title" | "whyItBreaks" | "file" | "lineStart">,
): Finding {
	return {
		severity: "P2",
		category: "bug",
		lineEnd: partial.lineStart,
		confidence: 0.8,
		suggestedFix: "",
		validation: "",
		...partial,
	};
}

test("fileMatchesAnchor: shorthand, exact, and character-suffix collision", () => {
	assert.equal(fileMatchesAnchor("src/cache.ts", "cache.ts"), true);
	assert.equal(fileMatchesAnchor("src/notcache.ts", "cache.ts"), false);
	assert.equal(fileMatchesAnchor("cache.ts", "cache.ts"), true);
	assert.equal(fileMatchesAnchor("src/cache.ts", "src/cache.ts"), true);
	assert.equal(fileMatchesAnchor("src/cache.ts", "notcache.ts"), false);
	assert.equal(fileMatchesAnchor("", "cache.ts"), false);
	assert.equal(fileMatchesAnchor("src/cache.ts", ""), false);
	// POSIX-only: backslash is an ordinary character, not a separator.
	assert.equal(fileMatchesAnchor("src\\cache.ts", "cache.ts"), false);
});

test("fileMatchesAnchor: nested packages match at a component boundary, not a character suffix", () => {
	// Uniform rule: a shorter anchor matches any finding whose remaining
	// suffix is the anchor after a slash. `other/pkg/a/src/cache.ts` therefore
	// matches `pkg/a/src/cache.ts`. Exact-only matching for multi-component
	// anchors is not implemented.
	assert.equal(
		fileMatchesAnchor("other/pkg/a/src/cache.ts", "pkg/a/src/cache.ts"),
		true,
	);
	assert.equal(
		fileMatchesAnchor("pkg/a/src/cache.ts", "pkg/a/src/cache.ts"),
		true,
	);
	assert.equal(
		fileMatchesAnchor("xother/pkg/a/src/cache.ts", "other/pkg/a/src/cache.ts"),
		false,
	);
	assert.equal(fileMatchesAnchor("foosrc/cache.ts", "src/cache.ts"), false);
});

test("matchesSpec: per-spec file uses component-boundary matching", () => {
	const hit = finding({
		title: "ttl inverted",
		whyItBreaks: "cache returns expired entries",
		file: "src/cache.ts",
		lineStart: 12,
	});
	const collision = finding({
		title: "ttl inverted",
		whyItBreaks: "cache returns expired entries",
		file: "src/notcache.ts",
		lineStart: 12,
	});
	assert.equal(matchesSpec(hit, { pattern: "ttl", file: "cache.ts" }), true);
	assert.equal(matchesSpec(hit, { pattern: "ttl", file: "src/cache.ts" }), true);
	assert.equal(
		matchesSpec(collision, { pattern: "ttl", file: "cache.ts" }),
		false,
	);
});

test("score: character-suffix collision does not grant recall", () => {
	const expected: Expected = {
		verdict: "changes_requested",
		mustFind: [{ pattern: "ttl", file: "cache.ts" }],
	};
	const collision = {
		verdict: "changes_requested" as Verdict,
		findings: [
			finding({
				title: "ttl inverted",
				whyItBreaks: "expired entries served",
				file: "src/notcache.ts",
				lineStart: 12,
			}),
		],
	};
	const hit = {
		verdict: "changes_requested" as Verdict,
		findings: [
			finding({
				title: "ttl inverted",
				whyItBreaks: "expired entries served",
				file: "src/cache.ts",
				lineStart: 12,
			}),
		],
	};
	assert.equal(score(collision, expected, "recall-collision").recall, false);
	assert.equal(score(hit, expected, "recall-hit").recall, true);
});

test("score: lineAnchorValid uses the same path semantics", () => {
	const withMustFind: Expected = {
		verdict: "changes_requested",
		mustFind: [{ pattern: "ttl" }],
		anchorFile: "cache.ts",
		anchorLineRange: [10, 14],
	};
	const collisionMust = {
		verdict: "changes_requested" as Verdict,
		findings: [
			finding({
				title: "ttl inverted",
				whyItBreaks: "expired",
				file: "src/notcache.ts",
				lineStart: 12,
			}),
		],
	};
	const hitMust = {
		verdict: "changes_requested" as Verdict,
		findings: [
			finding({
				title: "ttl inverted",
				whyItBreaks: "expired",
				file: "src/cache.ts",
				lineStart: 12,
			}),
		],
	};
	assert.equal(
		score(collisionMust, withMustFind, "anchor-must-collision").lineAnchorValid,
		false,
	);
	assert.equal(
		score(hitMust, withMustFind, "anchor-must-hit").lineAnchorValid,
		true,
	);

	// Negatives with an anchor and no mustFind: any-finding check, same rule.
	const noMustFind: Expected = {
		verdict: "pass",
		noBlockingFindings: true,
		anchorFile: "cache.ts",
	};
	const collisionNeg = {
		verdict: "pass" as Verdict,
		findings: [
			finding({
				title: "nit",
				whyItBreaks: "style",
				file: "src/notcache.ts",
				lineStart: 1,
				severity: "P3",
			}),
		],
	};
	const hitNeg = {
		verdict: "pass" as Verdict,
		findings: [
			finding({
				title: "nit",
				whyItBreaks: "style",
				file: "src/cache.ts",
				lineStart: 1,
				severity: "P3",
			}),
		],
	};
	assert.equal(
		score(collisionNeg, noMustFind, "anchor-neg-collision").lineAnchorValid,
		false,
	);
	assert.equal(score(hitNeg, noMustFind, "anchor-neg-hit").lineAnchorValid, true);
});

test("score: mayFind uses the same path semantics", () => {
	const expected: Expected = {
		verdict: "changes_requested",
		mustFind: [{ pattern: "viewer", file: "handler.ts" }],
		mayFind: [{ pattern: "buffer", file: "cache.ts" }],
	};
	const siblingCollision = finding({
		title: "buffer cap removed",
		whyItBreaks: "large diff aborts",
		file: "src/notcache.ts",
		lineStart: 3,
		severity: "P1",
	});
	const siblingHit = finding({
		title: "buffer cap removed",
		whyItBreaks: "large diff aborts",
		file: "src/cache.ts",
		lineStart: 3,
		severity: "P1",
	});
	const mustHit = finding({
		title: "viewer branch unreachable",
		whyItBreaks: "blocked",
		file: "src/handler.ts",
		lineStart: 18,
	});

	const miss = score(
		{ verdict: "changes_requested", findings: [siblingCollision, mustHit] },
		expected,
		"mayfind-collision",
	);
	assert.equal(miss.recall, true);
	assert.equal(
		miss.noiseFindingCount,
		1,
		"character-suffix sibling is still noise",
	);

	const exempt = score(
		{ verdict: "changes_requested", findings: [siblingHit, mustHit] },
		expected,
		"mayfind-hit",
	);
	assert.equal(exempt.recall, true);
	assert.equal(exempt.noiseFindingCount, 0);
});

test("score: mustNotFind / false-positive matching uses the same path semantics", () => {
	const expected: Expected = {
		verdict: "pass",
		mustNotFind: [{ pattern: "secret", file: "cache.ts" }],
	};
	const collision = {
		verdict: "changes_requested" as Verdict,
		findings: [
			finding({
				title: "secret leaked",
				whyItBreaks: "token in source",
				file: "src/notcache.ts",
				lineStart: 4,
			}),
		],
	};
	const hit = {
		verdict: "changes_requested" as Verdict,
		findings: [
			finding({
				title: "secret leaked",
				whyItBreaks: "token in source",
				file: "src/cache.ts",
				lineStart: 4,
			}),
		],
	};
	assert.equal(
		score(collision, expected, "fp-collision").falsePositive,
		false,
		"wrong-file mustNotFind hit is not that spec",
	);
	assert.equal(score(hit, expected, "fp-hit").falsePositive, true);
});

test("matchEvidence: uses the same path semantics", () => {
	const expected: Expected = {
		verdict: "changes_requested",
		anchorFile: "cache.ts",
		mustFind: [{ pattern: "ttl" }, { pattern: "queue", file: "queue.ts" }],
	};
	const collision = [
		finding({
			title: "ttl inverted",
			whyItBreaks: "expired",
			file: "src/notcache.ts",
			lineStart: 12,
		}),
	];
	const hit = [
		finding({
			title: "ttl inverted",
			whyItBreaks: "expired",
			file: "src/cache.ts",
			lineStart: 12,
		}),
	];
	assert.deepEqual(matchEvidence(collision, expected), [
		{ pattern: "ttl", file: "cache.ts", findingIndex: null },
		{ pattern: "queue", file: "queue.ts", findingIndex: null },
	]);
	assert.deepEqual(matchEvidence(hit, expected), [
		{ pattern: "ttl", file: "cache.ts", findingIndex: 0 },
		{ pattern: "queue", file: "queue.ts", findingIndex: null },
	]);
});
