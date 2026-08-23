import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "./review";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle } from "../shared/schema";

const FINDING = {
	severity: "P2",
	title: "Echo bug",
	category: "bug",
	file: "src/app.ts",
	lineStart: 1,
	lineEnd: 1,
	confidence: 0.9,
	whyItBreaks: "breaks",
	suggestedFix: "fix",
	validation: "pnpm test",
};

function makeBundle(repo: string, deep: boolean): Bundle {
	return {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep,
		focus: null,
	};
}

function candidateReview(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		summary: "candidate review",
		findings: [FINDING],
		checked: ["looked"],
		residual_risks: [],
		...overrides,
	};
}

function installStub(
	t: { after: (fn: () => void) => void },
	build: (calls: string) => string,
	env: { evalTrace?: boolean } = {},
): { repo: string; calls: string } {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-critic-subset-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
		trace: process.env.NEEDLEFISH_EVAL_TRACE,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(bin, build(calls));
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	if (env.evalTrace) process.env.NEEDLEFISH_EVAL_TRACE = "1";
	else delete process.env.NEEDLEFISH_EVAL_TRACE;
	return { repo, calls };
}

function smallPathBin(
	calls: string,
	reviewJson: unknown,
	criticJs: string,
): string {
	return [
		"#!/usr/bin/env node",
		"const fs = require('node:fs');",
		"let input = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => { input += chunk; });",
		"process.stdin.on('end', () => {",
		"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
		`  const calls = ${JSON.stringify(calls)};`,
		"  if (input.includes('adversarial critic')) {",
		"    fs.appendFileSync(calls, 'critic\\n');",
		"    const parsed = JSON.parse(input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat')));",
		`    ${criticJs}`,
		"    return;",
		"  }",
		"  fs.appendFileSync(calls, 'review\\n');",
		`  fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(reviewJson))});`,
		"});",
	].join("\n");
}

function largePathBin(calls: string, deepJson: unknown, criticJs: string): string {
	return [
		"#!/usr/bin/env node",
		"const fs = require('node:fs');",
		"let input = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => { input += chunk; });",
		"process.stdin.on('end', () => {",
		"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
		`  const calls = ${JSON.stringify(calls)};`,
		"  if (input.includes('review-MAP pass')) {",
		"    fs.appendFileSync(calls, 'map\\n');",
		"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'h1', files: ['src/app.ts'], why: 'changed', risk: 'high', edges: [] }] }));",
		"    return;",
		"  }",
		"  if (input.includes('doing a DEEP review')) {",
		"    fs.appendFileSync(calls, 'deep\\n');",
		`    fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(deepJson))});`,
		"    return;",
		"  }",
		"  if (input.includes('adversarial critic')) {",
		"    fs.appendFileSync(calls, 'critic\\n');",
		"    const parsed = JSON.parse(input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat')));",
		`    ${criticJs}`,
		"    return;",
		"  }",
		"  process.stderr.write('unexpected prompt');",
		"  process.exit(1);",
		"});",
	].join("\n");
}

const ECHO = "fs.writeFileSync(out, JSON.stringify(parsed));";
const PRUNE_FINDINGS =
	"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [] }));";

test("critic subset: small path rejects a critic-only finding", async (t) => {
	const { repo, calls } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview(),
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [{ severity: 'P0', title: 'critic-only marker', category: 'security', file: 'src/invented.ts', lineStart: 99, lineEnd: 99, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' }] }));",
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: finding was not in the candidate review/,
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review",
		"critic",
		"critic",
	]);
});

test("critic subset: small path rejects a critic-only blocking residual", async (t) => {
	const { repo, calls } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({ findings: [] }),
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [{ text: 'invented block', blocks: true }] }));",
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: residual risk was not in the candidate review/,
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review",
		"critic",
		"critic",
	]);
});

test("critic subset: small path accepts deleting all findings", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(log, candidateReview(), PRUNE_FINDINGS),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.findings, []);
});

test("critic subset: small path accepts downward severity correction without rewritten content", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview(),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, severity: "P3", validation: "rewritten-validation" })) }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "pass");
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0]?.severity, "P3");
	assert.equal(result.findings[0]?.title, "Echo bug");
	assert.equal(result.findings[0]?.whyItBreaks, "breaks");
	assert.equal(result.findings[0]?.suggestedFix, "fix");
	assert.equal(
		result.findings[0]?.validation,
		"pnpm test",
		"candidate content must be preserved; only severity/confidence may change",
	);
});

test("critic subset: small path accepts upward severity correction", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [{ ...FINDING, severity: "P3" }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, severity: "P2" })) }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "changes_requested");
	assert.equal(result.findings[0]?.severity, "P2");
	assert.equal(result.findings[0]?.title, "Echo bug");
});

const PARAPHRASE_CRITIC =
	'fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, title: "paraphrased title", whyItBreaks: "paraphrased why", suggestedFix: "paraphrased fix", lineStart: f.lineStart + 2, lineEnd: f.lineStart + 6, validation: "paraphrased validation", confidence: 0.8 })) }));';

function assertCandidateContentRestored(
	finding: typeof FINDING,
	candidate: typeof FINDING,
): void {
	assert.equal(finding.title, candidate.title);
	assert.equal(finding.whyItBreaks, candidate.whyItBreaks);
	assert.equal(finding.suggestedFix, candidate.suggestedFix);
	assert.equal(finding.lineStart, candidate.lineStart);
	assert.equal(finding.lineEnd, candidate.lineEnd);
	assert.equal(finding.validation, candidate.validation);
	assert.equal(finding.file, candidate.file);
	assert.equal(finding.category, candidate.category);
}

test("critic subset: small path accepts a paraphrased finding and restores candidate content", async (t) => {
	const candidate = { ...FINDING, lineStart: 10, lineEnd: 20 };
	const { repo } = installStub(t, (log) =>
		smallPathBin(log, candidateReview({ findings: [candidate] }), PARAPHRASE_CRITIC),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.findings.length, 1);
	assert.equal(result.verdict, "changes_requested");
	const finding = result.findings[0]!;
	assertCandidateContentRestored(finding, candidate);
	assert.equal(finding.severity, "P2");
	assert.equal(finding.confidence, 0.8);
	assert.notEqual(finding.title, "paraphrased title");
	assert.notEqual(finding.whyItBreaks, "paraphrased why");
	assert.notEqual(finding.suggestedFix, "paraphrased fix");
});

test("critic subset: large path accepts a paraphrased finding and restores candidate content", async (t) => {
	const candidate = { ...FINDING, lineStart: 10, lineEnd: 20 };
	const { repo } = installStub(t, (log) =>
		largePathBin(
			log,
			candidateReview({ findings: [candidate], summary: "deep h1" }),
			PARAPHRASE_CRITIC,
		),
	);

	const result = await review(makeBundle(repo, true));
	assert.equal(result.findings.length, 1);
	const finding = result.findings[0]!;
	assertCandidateContentRestored(finding, candidate);
	assert.equal(finding.confidence, 0.8);
});

test("critic subset: small path rejects lineStart drift outside the ±2 window", async (t) => {
	const candidate = { ...FINDING, lineStart: 10, lineEnd: 20 };
	const { repo, calls } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({ findings: [candidate] }),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, lineStart: 13 })) }));',
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: finding was not in the candidate review/,
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review",
		"critic",
		"critic",
	]);
});

// Two candidates equidistant (±2) from the critic's anchor: line distance
// alone cannot tell them apart, so only the critic's words can. Without the
// overlap tie-break the earlier candidate in array order wins and its content
// is shown under the critic's severity.
const LOOP_BOUND = {
	...FINDING,
	title: "Off-by-one loop bound",
	whyItBreaks: "the loop bound is off by one",
	suggestedFix: "start at zero",
	lineStart: 50,
	lineEnd: 50,
};
const NULL_CHECK = {
	...FINDING,
	title: "Missing null check",
	whyItBreaks: "the returned value is never null checked",
	suggestedFix: "check for null",
	lineStart: 54,
	lineEnd: 54,
};

// Anchored at 52 — delta 2 to both candidates. Built from candidate[0]
// (LOOP_BOUND) so every field except the paraphrased text points at the wrong
// candidate: the tie can only be resolved from title/whyItBreaks.
const NULL_CHECK_PARAPHRASE =
	"{ ...parsed.findings[0], title: 'null check missing on the returned value', whyItBreaks: 'the value returned is never checked for null', lineStart: 52, lineEnd: 52, severity: 'P1' }";
const LOOP_BOUND_PARAPHRASE =
	"{ ...parsed.findings[1], title: 'loop bound is off by one', whyItBreaks: 'the bound of the loop is off by one', lineStart: 52, lineEnd: 52, severity: 'P3' }";

test("critic subset: small path matches an equidistant tie by content, not candidate order", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({ findings: [LOOP_BOUND, NULL_CHECK] }),
			`fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [${NULL_CHECK_PARAPHRASE}] }));`,
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.findings.length, 1);
	const finding = result.findings[0]!;
	assertCandidateContentRestored(finding, NULL_CHECK);
	assert.notEqual(
		finding.title,
		LOOP_BOUND.title,
		"the tie must not be resolved by candidate array order",
	);
	assert.equal(finding.severity, "P1");
});

test("critic subset: small path keeps both equidistant candidates paired with their own severity", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({ findings: [LOOP_BOUND, NULL_CHECK] }),
			`fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [${NULL_CHECK_PARAPHRASE}, ${LOOP_BOUND_PARAPHRASE}] }));`,
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.findings.length, 2);
	assert.equal(result.verdict, "changes_requested");
	const nullCheck = result.findings.find((f) => f.title === NULL_CHECK.title);
	const loopBound = result.findings.find((f) => f.title === LOOP_BOUND.title);
	assert.ok(nullCheck, "the null-check candidate must survive");
	assert.ok(loopBound, "the loop-bound candidate must survive");
	assert.equal(nullCheck!.severity, "P1");
	assert.equal(nullCheck!.lineStart, NULL_CHECK.lineStart);
	assert.equal(loopBound!.severity, "P3");
	assert.equal(loopBound!.lineStart, LOOP_BOUND.lineStart);
});

test("critic subset: large path matches an equidistant tie by content, not candidate order", async (t) => {
	const { repo } = installStub(t, (log) =>
		largePathBin(
			log,
			candidateReview({
				findings: [LOOP_BOUND, NULL_CHECK],
				summary: "deep h1",
			}),
			`fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [${NULL_CHECK_PARAPHRASE}] }));`,
		),
	);

	const result = await review(makeBundle(repo, true));
	assert.equal(result.findings.length, 1);
	const finding = result.findings[0]!;
	assertCandidateContentRestored(finding, NULL_CHECK);
	assert.notEqual(finding.title, LOOP_BOUND.title);
	assert.equal(finding.severity, "P1");
});

// The tie-break must never decide admission. Wholly disjoint wording on both
// tied candidates has to keep matching (candidate order is the fallback),
// otherwise the 2026-08-22 paraphrase-rejection regression is back.
test("critic subset: small path still accepts a tie whose paraphrase shares no words", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({ findings: [LOOP_BOUND, NULL_CHECK] }),
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [{ ...parsed.findings[0], title: 'zzz qqq', whyItBreaks: 'zzz qqq', lineStart: 52, lineEnd: 52 }] }));",
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.findings.length, 1);
	assert.ok(
		[LOOP_BOUND.title, NULL_CHECK.title].includes(result.findings[0]!.title),
		"a candidate must still be matched when content gives no signal",
	);
});

const IDENTITY_REJECT_MUTATIONS = [
	{ field: "file", value: "src/other.ts" },
	{ field: "category", value: "security" },
] as const;

for (const { field, value } of IDENTITY_REJECT_MUTATIONS) {
	test(`critic subset: small path rejects a rewritten ${field}`, async (t) => {
		const { repo, calls } = installStub(t, (log) =>
			smallPathBin(
				log,
				candidateReview(),
				`fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, ${field}: ${JSON.stringify(value)} })) }));`,
			),
		);

		await assert.rejects(
			() => review(makeBundle(repo, false)),
			/malformed critic output: finding was not in the candidate review/,
		);
		assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
			"review",
			"critic",
			"critic",
		]);
	});
}

test("critic subset: small path allows two findings that share a loosened key", async (t) => {
	const first = {
		...FINDING,
		title: "First bug",
		whyItBreaks: "why one",
		suggestedFix: "fix one",
	};
	const second = {
		...FINDING,
		title: "Second bug",
		whyItBreaks: "why two",
		suggestedFix: "fix two",
	};
	const pair = candidateReview({ findings: [first, second] });
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			pair,
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f, i) => ({ ...f, title: "para " + i, whyItBreaks: "para why " + i, suggestedFix: "para fix " + i })) }));',
		),
	);
	const kept = await review(makeBundle(repo, false));
	assert.equal(kept.findings.length, 2);
	assert.equal(kept.verdict, "changes_requested");
	assert.deepEqual(
		kept.findings.map((f) => f.title).sort(),
		["First bug", "Second bug"],
	);
	assert.deepEqual(
		kept.findings.map((f) => f.whyItBreaks).sort(),
		["why one", "why two"],
	);
	assert.ok(kept.findings.every((f) => !f.title.startsWith("para ")));
});

test("critic subset: small path rejects a third copy of a duplicate loosened-key finding", async (t) => {
	const first = { ...FINDING, title: "First bug" };
	const second = { ...FINDING, title: "Second bug" };
	const pair = candidateReview({ findings: [first, second] });
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			pair,
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [...parsed.findings, parsed.findings[0]] }));",
		),
	);
	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: finding was not in the candidate review/,
	);
});

test("critic subset: small path allows two identical findings that share a key", async (t) => {
	const pair = candidateReview({ findings: [FINDING, FINDING] });
	const { repo } = installStub(t, (log) => smallPathBin(log, pair, ECHO));
	const kept = await review(makeBundle(repo, false));
	assert.equal(kept.findings.length, 2);
	assert.equal(kept.verdict, "changes_requested");
});

test("critic subset: small path rejects a third copy of a duplicate-key finding", async (t) => {
	const pair = candidateReview({ findings: [FINDING, FINDING] });
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			pair,
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [...parsed.findings, parsed.findings[0]] }));",
		),
	);
	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: finding was not in the candidate review/,
	);
});

test("critic subset: small path rejects upgrading a residual to blocking", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "maybe later", blocks: false }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [{ text: "maybe later", blocks: true }] }));',
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: residual risk is blocking but was not blocking in the candidate review/,
	);
});

test("critic subset: small path accepts unblocking a residual", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "need human", blocks: true }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [{ text: "need human", blocks: false }] }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.residualRisks, [
		{ text: "need human", blocks: false },
	]);
});

test("critic subset: small path accepts residual case/whitespace drift and restores candidate text", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "Need human", blocks: false }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [{ text: "NEED   human", blocks: false }] }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.residualRisks, [
		{ text: "Need human", blocks: false },
	]);
});

test("critic subset: small path rejects a word-paraphrased residual", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "Need human", blocks: false }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [{ text: "Need a human reviewer", blocks: false }] }));',
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: residual risk was not in the candidate review/,
	);
});

test("critic subset: large path rejects a critic-only finding", async (t) => {
	const { repo, calls } = installStub(t, (log) =>
		largePathBin(
			log,
			candidateReview({ summary: "deep h1" }),
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [{ severity: 'P0', title: 'critic-only marker', category: 'security', file: 'src/invented.ts', lineStart: 99, lineEnd: 99, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' }] }));",
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, true)),
		/malformed critic output: finding was not in the candidate review/,
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"map",
		"deep",
		"critic",
		"critic",
	]);
});

test("critic subset: large path rejects a critic-only blocking residual", async (t) => {
	const { repo, calls } = installStub(t, (log) =>
		largePathBin(
			log,
			candidateReview({ findings: [], summary: "deep h1" }),
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [{ text: 'invented block', blocks: true }] }));",
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, true)),
		/malformed critic output: residual risk was not in the candidate review/,
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"map",
		"deep",
		"critic",
		"critic",
	]);
});

test("critic subset: large path accepts prune of candidate findings", async (t) => {
	const { repo } = installStub(t, (log) =>
		largePathBin(
			log,
			candidateReview({ summary: "deep h1" }),
			PRUNE_FINDINGS,
		),
	);

	const result = await review(makeBundle(repo, true));
	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.findings, []);
});

test("critic subset: small path eval trace still records candidateFindings after prune", async (t) => {
	const { repo } = installStub(
		t,
		(log) => smallPathBin(log, candidateReview(), PRUNE_FINDINGS),
		{ evalTrace: true },
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.findings.length, 0);
	assert.ok(result.candidateFindings);
	assert.equal(result.candidateFindings!.length, 1);
	assert.equal(result.candidateFindings![0]?.title, "Echo bug");
	assert.equal(result.candidateFindings![0]?.severity, "P2");
});

test("critic subset: large path eval trace still records candidateFindings after prune", async (t) => {
	const { repo } = installStub(
		t,
		(log) =>
			largePathBin(
				log,
				candidateReview({ summary: "deep h1" }),
				PRUNE_FINDINGS,
			),
		{ evalTrace: true },
	);

	const result = await review(makeBundle(repo, true));
	assert.equal(result.findings.length, 0);
	assert.ok(result.candidateFindings);
	assert.equal(result.candidateFindings!.length, 1);
	assert.equal(result.candidateFindings![0]?.title, "Echo bug");
});
