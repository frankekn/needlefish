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
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [{ severity: 'P0', title: 'critic-only marker', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' }] }));",
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

test("critic subset: small path rejects rewritten finding content", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview(),
			'fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, title: "rewritten title" })) }));',
		),
	);

	await assert.rejects(
		() => review(makeBundle(repo, false)),
		/malformed critic output: finding was not in the candidate review/,
	);
});

// Pins findingSubsetKey: a critic that keeps file/line/category/title but
// rewrites any identity field must fail closed (retry then throw). A candidate
// with lineStart < lineEnd lets lineStart mutate without normalize rejecting
// "lineEnd before lineStart" first — otherwise that case would not pin the key.
const IDENTITY_FINDING = { ...FINDING, lineStart: 1, lineEnd: 10 };
const IDENTITY_FIELD_MUTATIONS = [
	{ field: "file", value: "src/other.ts" },
	{ field: "lineStart", value: 2 },
	{ field: "lineEnd", value: 9 },
	{ field: "category", value: "security" },
	{ field: "title", value: "rewritten title" },
	{ field: "whyItBreaks", value: "rewritten why" },
	{ field: "suggestedFix", value: "rewritten fix" },
] as const;

for (const { field, value } of IDENTITY_FIELD_MUTATIONS) {
	test(`critic subset: small path rejects a rewritten ${field}`, async (t) => {
		const { repo, calls } = installStub(t, (log) =>
			smallPathBin(
				log,
				candidateReview({ findings: [IDENTITY_FINDING] }),
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

test("critic subset: small path allows two findings that share a key", async (t) => {
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
