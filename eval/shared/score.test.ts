import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Verdict } from "../../src/shared/schema";
import selfReviewCheckout from "../fixtures-real/real-pr1-self-review-tool-checkout/spec";
import invertedGuard from "../fixtures/t1-inverted-guard/spec";
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

const structuredCases = [
	{
		fixture: invertedGuard,
		lineStart: 12,
		facts: [
			"Admins are forbidden.",
			"Non-admins can delete.",
		],
	},
	{
		fixture: selfReviewCheckout,
		lineStart: 34,
		facts: [
			"The PR head executes Needlefish.",
			"The reviewer has write access to checks.",
		],
	},
] as const;

for (const { fixture, lineStart, facts } of structuredCases) {
	test(`${fixture.id}: structured facts may span anchored findings`, () => {
		const makeFinding = (text: string) =>
			finding({
				title: "Authorization defect",
				whyItBreaks: text,
				file: fixture.expected.anchorFile!,
				lineStart,
			});
		const hit = (findings: readonly Finding[]) =>
			score(
				{ verdict: "changes_requested", findings },
				fixture.expected,
				fixture.id,
			).recall;

		assert.equal(hit([makeFinding(facts.join(" "))]), true);
		assert.equal(hit([makeFinding([...facts].reverse().join(" "))]), true);
		assert.equal(
			hit(facts.map(makeFinding)),
			true,
			"facts split across eligible findings combine into a hit",
		);
		assert.equal(hit([
			makeFinding(facts[0]),
			{ ...makeFinding(facts[1]), file: "unrelated.ts" },
		]), false);
		for (let removed = 0; removed < facts.length; removed += 1) {
			assert.equal(
				hit([makeFinding(facts.filter((_, index) => index !== removed).join(" "))]),
				false,
				`removing required fact ${removed} must cause a miss`,
			);
		}
	});
}

test("split facts: evidence, noise, filters, line diagnostics, and critic pruning agree", () => {
	const spec = {
		facts: ["alpha", "beta"].map((word) => ({
			id: word, meaning: word, alternatives: [{ allOf: [word] }],
		})),
		category: "bug" as const,
	};
	const expected: Expected = {
		verdict: "changes_requested", anchorFile: "cache.ts",
		anchorLineRange: [10, 20], mustFind: [spec],
	};
	const findings = ["unrelated", "alpha", "beta"].map((title, index) =>
		finding({ title, whyItBreaks: "", file: "src/cache.ts", lineStart: 10 + index }),
	);
	const run = (final: readonly Finding[], expectation = expected) => score(
		{ verdict: "changes_requested", findings: final, candidateFindings: findings },
		expectation, "split-facts",
	);
	assert.equal(run(findings).recall, true);
	assert.equal(run(findings).noiseFindingCount, 1);
	assert.equal(run(findings).lineAnchorValid, true);
	assert.equal(run(findings).criticPruneError, false);
	assert.equal(matchEvidence(findings, expected)[0]?.findingIndex, 1);
	assert.equal(run(findings.slice(0, 2)).criticPruneError, true);
	assert.equal(run(findings.slice(0, 2)).noiseFindingCount, 2);
	assert.equal(matchEvidence(findings.slice(0, 2), expected)[0]?.findingIndex, null);
	for (const patch of [
		{ file: "src/notcache.ts" }, { category: "security" as const },
	]) {
		assert.equal(run([findings[1]!, { ...findings[2]!, ...patch }]).recall, false);
	}
	const outside = [findings[1]!, { ...findings[2]!, lineStart: 30 }];
	assert.equal(run(outside).recall, true);
	assert.equal(run(outside).lineAnchorValid, false);
	assert.equal(run(outside, { ...expected, mustFind: [{ ...spec, lineRange: [10, 20] }] }).recall, false);
	const patternExpected = { ...expected, mustFind: [{ pattern: "alpha.*beta" }] };
	assert.equal(run(findings, patternExpected).recall, false);
	assert.equal(run([{ ...findings[1]!, whyItBreaks: "beta" }], patternExpected).recall, true);
	assert.equal(matchesSpec(findings[1]!, spec), false);
	const forbidden = run(findings, { ...expected, mustNotFind: [spec], trap: [spec] });
	assert.equal(forbidden.falsePositive, false);
	assert.equal(forbidden.cheatDetected, false);
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

test("matchEvidence names a complete finding before a partial contributor", () => {
	const spec = {
		facts: ["alpha", "beta"].map((word) => ({
			id: word, meaning: word, alternatives: [{ allOf: [word] }],
		})),
	};
	const expected: Expected = {
		verdict: "changes_requested", anchorFile: "x.ts", mustFind: [spec],
	};
	const partialFirst = [
		finding({ title: "alpha only", whyItBreaks: "", file: "x.ts", lineStart: 1 }),
		finding({ title: "alpha and beta", whyItBreaks: "", file: "x.ts", lineStart: 2 }),
	];
	assert.equal(matchEvidence(partialFirst, expected)[0]?.findingIndex, 1);
	// A hit that is necessarily split still names its first contributor.
	const split = [
		finding({ title: "beta", whyItBreaks: "", file: "x.ts", lineStart: 1 }),
		finding({ title: "alpha", whyItBreaks: "", file: "x.ts", lineStart: 2 }),
	];
	assert.equal(matchEvidence(split, expected)[0]?.findingIndex, 0);
});

// Widened fixture alternatives must still bind the consequence to its actor:
// with facts allowed to span findings, an actor-free consequence finding
// next to a correct first-fact finding must not manufacture a hit.
test("split facts do not admit actor-free consequence findings", async () => {
	const inverted = (await import("../fixtures/t1-inverted-guard/spec")).default;
	const adminRejected = finding({
		title: "Admins are now forbidden", whyItBreaks: "user.isAdmin true returns forbidden",
		file: "src/projects.ts", lineStart: 12,
	});
	const actorFreeDelete = finding({
		title: "Archived path runs db.delete", whyItBreaks: "the archived branch runs db.delete unconditionally",
		file: "src/projects.ts", lineStart: 14,
	});
	assert.equal(
		score({ verdict: "changes_requested", findings: [adminRejected, actorFreeDelete] }, inverted.expected, inverted.id).recall,
		false,
	);
	const nonAdminDelete = finding({
		title: "Non-admins can purge", whyItBreaks: "isAdmin: false falls through to db.delete",
		file: "src/projects.ts", lineStart: 14,
	});
	assert.equal(
		score({ verdict: "changes_requested", findings: [adminRejected, nonAdminDelete] }, inverted.expected, inverted.id).recall,
		true,
	);

	const selfReview = (await import("../fixtures-real/real-pr1-self-review-tool-checkout/spec")).default;
	const prControlsTool = finding({
		title: "PR head executes src/cli.ts", whyItBreaks: "The PR head is checked out and executes src/cli.ts",
		file: ".github/workflows/review.yml", lineStart: 43,
	});
	const actorFreeSuppress = finding({
		title: "Service can suppress checks", whyItBreaks: "a service can suppress checks in this workflow",
		file: ".github/workflows/review.yml", lineStart: 49,
	});
	assert.equal(
		score({ verdict: "changes_requested", findings: [prControlsTool, actorFreeSuppress] }, selfReview.expected, selfReview.id).recall,
		false,
	);
	const prForges = finding({
		title: "PR can forge its review", whyItBreaks: "the PR can forge or suppress its own review result",
		file: ".github/workflows/review.yml", lineStart: 49,
	});
	assert.equal(
		score({ verdict: "changes_requested", findings: [prControlsTool, prForges] }, selfReview.expected, selfReview.id).recall,
		true,
	);
	// A finding that names the PR's control over the CLI but denies that the
	// PR-controlled code runs must not satisfy the first fact, even next to a
	// correct write-authority finding.
	const prChangesButTrustedRuns = finding({
		title: "PR changes the CLI", whyItBreaks: "The PR changes Needlefish's CLI, but this job executes the trusted checkout",
		file: ".github/workflows/review.yml", lineStart: 43,
	});
	const tokenWrites = finding({
		title: "Token can write checks", whyItBreaks: "GITHUB_TOKEN has checks: write and pull-requests: write",
		file: ".github/workflows/review.yml", lineStart: 20,
	});
	assert.equal(
		score({ verdict: "changes_requested", findings: [prChangesButTrustedRuns, tokenWrites] }, selfReview.expected, selfReview.id).recall,
		false,
	);
	// The PR checkout is mentioned but the install comes FROM the trusted
	// checkout: the fact is denied, so no hit and the finding counts as noise.
	const trustedInstall = finding({
		title: "PR-head checkout is present", whyItBreaks: "The PR-head checkout is present, but the job installs Needlefish from the trusted checkout",
		file: ".github/workflows/review.yml", lineStart: 43,
	});
	const trustedInstallResult = score({ verdict: "changes_requested", findings: [trustedInstall, tokenWrites] }, selfReview.expected, selfReview.id);
	assert.equal(trustedInstallResult.recall, false);
	assert.ok(trustedInstallResult.noiseFindingCount > 0);
	// The real phrasing still hits: the reviewer is run FROM the PR checkout.
	const fromPrCheckout = finding({
		title: "Reviewer runs from the PR checkout", whyItBreaks: "The job installs it and executes src/cli.ts from that same PR checkout",
		file: ".github/workflows/review.yml", lineStart: 43,
	});
	assert.equal(score({ verdict: "changes_requested", findings: [fromPrCheckout, tokenWrites] }, selfReview.expected, selfReview.id).recall, true);

	// t1-inverted-guard: "isAdmin: false returns forbidden, so the user cannot
	// purge" asserts the OPPOSITE of the destructive-reachability fact.
	const forbiddenNonAdmin = finding({
		title: "Forbidden path is unreachable", whyItBreaks: "isAdmin: false returns forbidden, so the user cannot purge",
		file: "src/projects.ts", lineStart: 12,
	});
	assert.equal(
		score({ verdict: "changes_requested", findings: [adminRejected, forbiddenNonAdmin] }, inverted.expected, inverted.id).recall,
		false,
	);
});

// ts-backend-slop-swallow: the description's fact ("swallows the error and
// returns an empty string, masking failures for callers") is stated by real
// reviews as the consequence rather than the verb. Each phrasing below came
// from a recorded miss; the anchor is still required.
test("slop-swallow oracle admits consequence phrasings on the anchor only", async () => {
	const spec = (await import("../fixtures/ts-backend-slop-swallow/spec")).default;
	const run = (whyItBreaks: string, file = "src/store.ts") =>
		score(
			{ verdict: "changes_requested", findings: [finding({ title: "Preserve missing-key errors from load", whyItBreaks, file, lineStart: 6 })] },
			spec.expected,
			spec.id,
		).recall;
	const phrasings = [
		'the new catch converts it to "", which is a legitimate stored value. Direct callers can no longer distinguish a failed lookup from an empty value',
		'A missing key now returns "", which is also a valid value. loadAll returns an apparently successful array instead of propagating the missing-key error',
		"A missing key previously threw; it now returns an empty string that callers cannot distinguish from a stored value",
	];
	for (const why of phrasings) assert.equal(run(why), true, why);
	for (const why of phrasings) assert.equal(run(why, "src/other.ts"), false, "anchor still required");
	assert.equal(run("The lookup is slower because the map is copied on every call"), false);
	// Opposite or unrelated claims on the anchor must not score: no loss named.
	assert.equal(run("A missing key should never throw; this change is correct"), false);
	assert.equal(run("The catch converts the error into a typed Result and callers must check it"), false);
	assert.equal(run("The error is not propagated to the logger, only to the caller"), false);
});
