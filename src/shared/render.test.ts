import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "./render";
import {
	REVIEW_RESULT_SCHEMA_VERSION,
	type Finding,
	type ReviewResult,
	type Verdict,
} from "./schema";

function finding(
	severity: Finding["severity"],
	title: string,
	file: string,
	overrides: Partial<Finding> = {},
): Finding {
	return {
		severity,
		title,
		category: "bug",
		file,
		lineStart: 1,
		lineEnd: 1,
		confidence: 0.9,
		whyItBreaks: "breaks",
		suggestedFix: "fix it",
		validation: "run the test",
		...overrides,
	};
}

function baseResult(
	findings: readonly Finding[] = [],
	verdict: Verdict = "changes_requested",
): ReviewResult {
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		verdict,
		summary: "First sentence. Second sentence is omitted.",
		findings,
		checked: ["diff"],
		residualRisks: [],
		baseSha: "base",
		headSha: "head",
	};
}

test("renderMarkdown uses the headline for each verdict and the first summary sentence", () => {
	assert.equal(
		renderMarkdown(baseResult([], "pass")).split("\n")[0],
		"LGTM ✅ — First sentence.",
	);
	assert.equal(
		renderMarkdown(baseResult([], "changes_requested")).split("\n")[0],
		"CHANGES REQUESTED ⚠️ — First sentence.",
	);
	assert.equal(
		renderMarkdown(baseResult([], "needs_human")).split("\n")[0],
		"NEEDS HUMAN 👀 — First sentence.",
	);

	assert.equal(
		renderMarkdown({ ...baseResult([], "pass"), summary: "" }).split("\n")[0],
		"LGTM ✅",
	);
});

test("renderMarkdown sorts findings and shows every severity label in the table and details", () => {
	const findings = [
		finding("P3", "low", "low.ts", { lineStart: 40, lineEnd: 42 }),
		finding("P1", "high", "high.ts", { lineStart: 12, lineEnd: 12 }),
		finding("P2", "uses | pipe\nand newline", "medium.ts"),
		finding("P0", "critical", "critical.ts"),
	];

	const markdown = renderMarkdown(baseResult(findings));

	assert.match(markdown, /\| 1 \| 🔴 P0 \| critical \| `critical\.ts:1` \|/);
	assert.match(markdown, /\| 2 \| 🟠 P1 \| high \| `high\.ts:12` \|/);
	assert.match(
		markdown,
		/\| 3 \| 🟡 P2 \| uses \\\| pipe and newline \| `medium\.ts:1` \|/,
	);
	assert.match(markdown, /\| 4 \| ⚪ P3 \| low \| `low\.ts:40-42` \|/);
	assert.match(markdown, /### 🔴 P0 F1: critical/);
	assert.match(markdown, /### 🟠 P1 F2: high/);
	assert.match(markdown, /### 🟡 P2 F3: uses \| pipe and newline/);
	assert.match(markdown, /### ⚪ P3 F4: low/);
});

test("renderMarkdown links locations only when repository context is available", () => {
	const linked = renderMarkdown(
		baseResult([
			finding("P1", "single", "src/single.ts", {
				lineStart: 24,
				lineEnd: 24,
			}),
			finding("P2", "range", "src/a space/é.ts", {
				lineStart: 24,
				lineEnd: 31,
			}),
			finding("P3", "no file", ""),
		]),
		{ repoSlug: "owner/name" },
	);

	assert.match(
		linked,
		/\[`src\/single\.ts:24`\]\(https:\/\/github\.com\/owner\/name\/blob\/head\/src\/single\.ts#L24\)/,
	);
	assert.match(
		linked,
		/\[`src\/a space\/é\.ts:24-31`\]\(https:\/\/github\.com\/owner\/name\/blob\/head\/src\/a%20space\/%C3%A9\.ts#L24-L31\)/,
	);
	assert.match(linked, /\| 3 \| ⚪ P3 \| no file \| — \|/);

	const plain = renderMarkdown(
		baseResult([
			finding("P1", "plain", "src/plain.ts", {
				lineStart: 7,
				lineEnd: 9,
			}),
		]),
	);
	assert.match(plain, /\| `src\/plain\.ts:7-9` \|/);
	assert.doesNotMatch(plain, /github\.com/);
});

test("renderMarkdown adds blocking and nit counts directly below the headline", () => {
	const four = renderMarkdown(
		baseResult([
			finding("P0", "zero", "a.ts"),
			finding("P1", "one", "b.ts"),
			finding("P2", "two", "c.ts"),
			finding("P3", "three", "d.ts"),
		]),
	);
	// Red-reason headline replaces the summary on line 1; the summary
	// first-sentence then carries to line 2, counts follow on line 3.
	assert.match(four, /^[^\n]+\nFirst sentence\.\n\*\*3 blocking\*\* · 1 nit\n/);

	const blocking = renderMarkdown(baseResult([finding("P2", "one", "a.ts")]));
	assert.match(blocking, /^[^\n]+\nFirst sentence\.\n\*\*1 blocking\*\*\n/);

	const nits = renderMarkdown(
		baseResult([finding("P3", "one", "a.ts"), finding("P3", "two", "b.ts")]),
	);
	assert.match(nits, /^[^\n]+\n2 nits\n/);

	const none = renderMarkdown(baseResult([]));
	assert.doesNotMatch(none, /blocking|\bnits?\b/);
});

test("renderMarkdown shows compact re-review deltas only for positive counts", () => {
	const result = baseResult([finding("P2", "one", "a.ts")]);
	// Summary occupies line 2 (reason replaced the headline); counts then delta.
	assert.match(
		renderMarkdown(result, { resolvedCount: 2 }),
		/^([^\n]+\n)First sentence\.\n\*\*1 blocking\*\*\n✅ 2 resolved\n/,
	);
	assert.match(
		renderMarkdown(result, { newCount: 1 }),
		/^([^\n]+\n)First sentence\.\n\*\*1 blocking\*\*\n🆕 1 new\n/,
	);
	assert.match(
		renderMarkdown(result, { resolvedCount: 2, newCount: 1 }),
		/^([^\n]+\n)First sentence\.\n\*\*1 blocking\*\*\n✅ 2 resolved · 🆕 1 new\n/,
	);
	assert.doesNotMatch(
		renderMarkdown(result, { resolvedCount: 0, newCount: 0 }),
		/resolved|🆕/,
	);
});

test("renderMarkdown uses the required zero-findings text without a table", () => {
	const markdown = renderMarkdown(baseResult([]));

	assert.match(
		markdown,
		/## Findings\n\nNo actionable findings\. Prefer this over padding weak ones\./,
	);
	assert.doesNotMatch(markdown, /\| # \| Severity/);
	assert.doesNotMatch(markdown, /<summary>Finding details<\/summary>/);
});

test("renderMarkdown marks an inlined table finding and omits only its detail section", () => {
	const inlined = finding("P2", "in diff", "a.ts");
	const outside = finding("P3", "outside", "b.ts");

	const markdown = renderMarkdown(baseResult([inlined, outside]), {
		inlinedFindings: new Set([inlined]),
	});

	assert.match(
		markdown,
		/\| 1 \| 🟡 P2 \| in diff <sub>\(inline comment\)<\/sub> \| `a\.ts:1` \|/,
	);
	assert.doesNotMatch(markdown, /### 🟡 P2 F1: in diff/);
	assert.match(markdown, /### ⚪ P3 F2: outside/);
});

test("renderMarkdown prefixes only blocking residual risks", () => {
	const markdown = renderMarkdown({
		...baseResult([]),
		residualRisks: [
			{ text: "blocks merge", blocks: true },
			{ text: "monitor later", blocks: false },
		],
	});

	assert.match(markdown, /<summary>Residual risk \(2\)<\/summary>/);
	assert.match(markdown, /- ⛔ blocks merge/);
	assert.match(markdown, /- monitor later/);
	assert.doesNotMatch(markdown, /⛔ monitor later/);
});

test("renderMarkdown preserves review target, round state options, marker, and stats", () => {
	const open = finding("P2", "still broken", "open.ts");
	const result: ReviewResult = {
		...baseResult([]),
		reviewTarget:
			"Review target: local base..head\nPR context: #24 metadata only",
		stats: [
			{
				label: "review",
				runner: "codex",
				durationMs: 212000,
				attempts: 2,
				ok: true,
			},
			{
				label: "critic",
				runner: "codex",
				durationMs: 96000,
				attempts: 1,
				ok: true,
			},
		],
		totalDurationMs: 308000,
	};

	const markdown = renderMarkdown(result, {
		openFindings: [open],
		resolvedCount: 1,
		stateMarker: "<!-- state -->",
	});

	assert.match(markdown, /^CHANGES REQUESTED ⚠️[^\n]*\n✅ 1 resolved\n/);
	assert.match(markdown, /Review target: local base\.\.head/);
	assert.match(markdown, /PR context: #24 metadata only/);
	assert.match(markdown, /<summary>Still open \(1\)<\/summary>/);
	assert.match(markdown, /<summary>Checked \(1\)<\/summary>/);
	assert.match(
		markdown,
		/<sub>2 calls · review 3m 32s → critic 1m 36s · 1 retry · total 5m 8s<\/sub>/,
	);
	assert.match(markdown, /<!-- state -->\n$/);
});

test("renderMarkdown red-reason headline names the top blocking finding and its location", () => {
	const markdown = renderMarkdown(
		baseResult([
			finding("P3", "nit only", "nit.ts"),
			finding("P1", "Top blocking bug", "src/auth.ts", {
				lineStart: 88,
				lineEnd: 90,
			}),
			finding("P2", "other blocker", "src/util.ts", { lineStart: 4 }),
		]),
	);
	const firstLine = markdown.split("\n")[0];
	// The most severe (P1) finding is the top after the severity sort.
	assert.match(firstLine, /Top blocking bug/);
	assert.match(firstLine, /src\/auth\.ts:88/);
	// Multiple blocking findings get the (+N more) suffix.
	assert.match(firstLine, /\(\+1 more\)/);
});

test("renderMarkdown needs_human headline carries the blocking residual and a visible why-not-green line", () => {
	const markdown = renderMarkdown({
		...baseResult([], "needs_human"),
		residualRisks: [
			{
				text: "deep review of the auth hotspot failed; not fully covered",
				blocks: true,
			},
		],
	});
	const firstLine = markdown.split("\n")[0];
	assert.match(
		firstLine,
		/NEEDS HUMAN 👀 — deep review of the auth hotspot failed/,
	);
	// A non-collapsed ⛔ line must appear before the first <details>.
	const detailsIdx = markdown.indexOf("<details>");
	assert.ok(detailsIdx > 0, "expected a collapsed details section");
	const beforeDetails = markdown.slice(0, detailsIdx);
	assert.match(beforeDetails, /^- ⛔ .*not fully covered/m);
	assert.match(beforeDetails, /\*\*⛔ Why not green:\*\*/);
});

test("renderMarkdown renders the coverage line visibly outside any collapsed section", () => {
	const markdown = renderMarkdown({
		...baseResult([], "pass"),
		coverage:
			"3/3 changed files deep-reviewed across 2 hotspots, incl. tail-coverage",
	});
	const detailsIdx = markdown.indexOf("<details>");
	const beforeDetails =
		detailsIdx > 0 ? markdown.slice(0, detailsIdx) : markdown;
	assert.match(beforeDetails, /^Coverage: 3\/3 changed files/m);
	// Preceded by a blank line: otherwise GFM lazy-continues the previous
	// bullet list / paragraph and the coverage line is absorbed into it.
	assert.match(markdown, /\n\nCoverage: /);
});
