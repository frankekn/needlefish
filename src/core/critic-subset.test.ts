import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "./review";
import type { ReviewTraceEvent } from "./review-trace.js";
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
		"    const ledger = { summary: parsed.summary, decisions: parsed.findings.map(({ ref, severity, confidence }) => ({ ref, action: 'keep', severity, confidence })), checked: parsed.checked, residual_risks: parsed.residual_risks };",
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
		"    const ledger = { summary: parsed.summary, decisions: parsed.findings.map(({ ref, severity, confidence }) => ({ ref, action: 'keep', severity, confidence })), checked: parsed.checked, residual_risks: parsed.residual_risks };",
		`    ${criticJs}`,
		"    return;",
		"  }",
		"  process.stderr.write('unexpected prompt');",
		"  process.exit(1);",
		"});",
	].join("\n");
}

const ECHO = "fs.writeFileSync(out, JSON.stringify(ledger));";
const PRUNE_FINDINGS = "fs.writeFileSync(out, JSON.stringify({ ...ledger, decisions: parsed.findings.map(({ ref }) => ({ ref, action: 'drop' })) }));";

for (const deep of [false, true]) {
	const lane = deep ? "large" : "small";
	const bin = deep ? largePathBin : smallPathBin;
	for (const [label, changes, expected] of [
		["downgrade", { severity: "P3", confidence: 0 }, "pass"],
		["upgrade", { severity: "P0", confidence: 1 }, "changes_requested"],
		["blocking confidence boundary", { severity: "P2", confidence: 0.7 }, "changes_requested"],
	] as const) {
		test(`critic ledger: ${lane} ${label} preserves candidate content`, async (t) => {
			const { repo } = installStub(t, log => bin(log, candidateReview(),
				`fs.writeFileSync(out, JSON.stringify({ ...ledger, decisions: ledger.decisions.map(d => ({ ...d, ...${JSON.stringify(changes)} })) }));`));
			const result = await review(makeBundle(repo, deep));
			assert.equal(result.verdict, expected);
			const { evidence, replacement, ...finding } = result.findings[0];
			assert.deepEqual(finding, { ...FINDING, ...changes, consumerFile: undefined, consumerLine: undefined });
			assert.equal(evidence?.toolRead, "unknown");
			assert.equal(replacement, undefined);
			assert.equal("ref" in result.findings[0], false);
			assert.equal("decisions" in result, false);
		});
	}
	test(`critic ledger: ${lane} explicit prune preserves candidate trace`, async (t) => {
		const { repo } = installStub(t, log => bin(log, candidateReview(), PRUNE_FINDINGS), { evalTrace: true });
		const result = await review(makeBundle(repo, deep));
		assert.equal(result.verdict, "pass");
		assert.deepEqual(result.findings, []);
		assert.equal(result.candidateFindings?.[0]?.title, FINDING.title);
		assert.equal("ref" in (result.candidateFindings?.[0] ?? {}), false);
		assert.match(result.rawOutputs?.at(-1) ?? "", /"decisions"/);
	});
	test(`critic ledger: ${lane} empty candidate accepts empty ledger`, async (t) => {
		const { repo } = installStub(t, log => bin(log, candidateReview({ findings: [] }), ECHO));
		assert.deepEqual((await review(makeBundle(repo, deep))).findings, []);
	});
	test(`critic ledger: ${lane} reordered same-location candidates retain decision pairing`, async (t) => {
		const second = { ...FINDING, title: "Second bug", whyItBreaks: "different failure", severity: "P3" };
		const { repo } = installStub(t, log => bin(log, candidateReview({ findings: [FINDING, second] }),
			"fs.writeFileSync(out, JSON.stringify({ ...ledger, decisions: [{ ref: 'f1', action: 'keep', severity: 'P0', confidence: 1 }, { ref: 'f0', action: 'keep', severity: 'P3', confidence: 0 }] }));"));
		const result = await review(makeBundle(repo, deep));
		assert.deepEqual(result.findings.map(f => [f.title, f.severity, f.confidence, f.lineStart]), [["Second bug", "P0", 1, 1], ["Echo bug", "P3", 0, 1]]);
	});
	for (const [label, output] of [
		["unknown ref", "{ ...ledger, decisions: [{ ...ledger.decisions[0], ref: 'f99' }] }"],
		["duplicate ref", "{ ...ledger, decisions: [...ledger.decisions, ledger.decisions[0]] }"],
		["missing ref", "{ ...ledger, decisions: [] }"],
		["legacy findings", "parsed"],
		["mixed findings", "{ ...ledger, findings: [] }"],
		["extra envelope key", "{ ...ledger, extra: true }"],
		["missing envelope key", "{ decisions: ledger.decisions, checked: ['looked'], residual_risks: [] }"],
		["null envelope", "null"],
		["array envelope", "[]"],
		["non-array decisions", "{ ...ledger, decisions: {} }"],
		["missing ref field", "{ ...ledger, decisions: [{ action: 'drop' }] }"],
		["missing action field", "{ ...ledger, decisions: [{ ref: 'f0' }] }"],
		["array decision", "{ ...ledger, decisions: [[]] }"],
		["null decision", "{ ...ledger, decisions: [null] }"],
		["invalid action", "{ ...ledger, decisions: [{ ref: 'f0', action: 'maybe' }] }"],
		["drop with severity", "{ ...ledger, decisions: [{ ref: 'f0', action: 'drop', severity: 'P3' }] }"],
		["rewritten location", "{ ...ledger, decisions: [{ ...ledger.decisions[0], lineStart: 86 }] }"],
		["rewritten content", "{ ...ledger, decisions: [{ ...ledger.decisions[0], title: 'rewritten' }] }"],
		["missing confidence", "{ ...ledger, decisions: [{ ref: 'f0', action: 'keep', severity: 'P2' }] }"],
		["lowercase severity", "{ ...ledger, decisions: [{ ...ledger.decisions[0], severity: 'p2' }] }"],
		["invalid severity", "{ ...ledger, decisions: [{ ...ledger.decisions[0], severity: 'P9' }] }"],
		["string confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], confidence: '0.9' }] }"],
		["negative confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], confidence: -0.1 }] }"],
		["excess confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], confidence: 1.1 }] }"],
		["nonfinite confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], confidence: Infinity }] }"],
		["low P0 confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], severity: 'P0', confidence: 0.69 }] }"],
		["low P1 confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], severity: 'P1', confidence: 0.69 }] }"],
		["low blocking confidence", "{ ...ledger, decisions: [{ ...ledger.decisions[0], confidence: 0.69 }] }"],
	] as const) {
		test(`critic ledger: ${lane} rejects ${label} after three raw attempts`, async (t) => {
			const { repo, calls } = installStub(t, log => bin(log, candidateReview(), `fs.writeFileSync(out, JSON.stringify(${output}));`), { evalTrace: true });
			const events: ReviewTraceEvent[] = [];
			await assert.rejects(review(makeBundle(repo, deep), {}, event => { events.push(event); }), error => {
				assert.ok(error instanceof Error);
				assert.match(error.message, label === "null envelope" || label === "array envelope"
					? /no JSON object found in codex output/
					: /malformed (critic output|finding)/);
				assert.ok("rawOutputs" in error && Array.isArray(error.rawOutputs));
				assert.ok(error.rawOutputs.length >= 3);
				return true;
			});
			assert.equal(events.filter(event => event.passKind === "critic" && event.outcome === "parse_failed").length, 3);
			assert.equal(readFileSync(calls, "utf8").split("\n").filter(line => line === "critic").length, 3);
		});
	}
	test(`critic ledger: ${lane} accepts third response and retains rejected raws`, async (t) => {
		const { repo, calls } = installStub(t, log => bin(log, candidateReview(),
			"const n = fs.readFileSync(calls, 'utf8').split('\\n').filter(line => line === 'critic').length; fs.writeFileSync(out, JSON.stringify(n < 3 ? { ...ledger, decisions: [] } : ledger));"), { evalTrace: true });
		const result = await review(makeBundle(repo, deep));
		assert.equal(result.findings[0]?.title, FINDING.title);
		assert.equal(result.failedRawOutputs?.length, 2);
		assert.equal(readFileSync(calls, "utf8").split("\n").filter(line => line === "critic").length, 3);
	});
}

test("critic ledger: small path restores the candidate list on a blocking upgrade", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "maybe later", blocks: false }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: [{ text: "maybe later", blocks: true }] }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.residualRisks, [
		{ text: "maybe later", blocks: false },
	]);
});

for (const deep of [false, true]) {
	const pipeline = deep ? largePathBin : smallPathBin;
	const lane = deep ? "large" : "small";
	for (const action of ["keep", "downgrade", "omit"]) {
		test(`critic ledger: ${lane} path permits model residual ${action}`, async (t) => {
			const expected = action === "omit" ? [] : [
				{ text: "need human", blocks: action === "keep" },
			];
			const { repo } = installStub(t, (log) => pipeline(
				log,
				candidateReview({
					findings: [],
					residual_risks: [{ text: "need human", blocks: true }],
				}),
				`fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: ${JSON.stringify(expected)} }));`,
			));
			const result = await review(makeBundle(repo, deep));
			assert.equal(result.verdict, action === "keep" ? "needs_human" : "pass");
			assert.deepEqual(result.residualRisks, expected);
		});
	}

	test(`critic ledger: ${lane} path consolidates duplicate residual text`, async (t) => {
		const { repo } = installStub(t, (log) => pipeline(
			log,
			candidateReview({ findings: [], residual_risks: [
				{ text: "Need human", blocks: false },
				{ text: "NEED   human", blocks: true },
			] }),
			ECHO,
		));
		const result = await review(makeBundle(repo, deep));
		assert.equal(result.verdict, "needs_human");
		assert.deepEqual(result.residualRisks, [{ text: "NEED   human", blocks: true }]);
	});
}

for (const action of ["keep", "downgrade", "omit"]) {
	test(`critic ledger: deep infrastructure failure survives critic ${action}`, async (t) => {
		const { repo } = installStub(t, (log) => largePathBin(
			log,
			null,
			`fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: ${action === "omit" ? "[]" : `parsed.residual_risks.map(risk => ({ ...risk, blocks: ${action === "keep"} }))`} }));`,
		));
		const result = await review(makeBundle(repo, true));
		assert.equal(result.verdict, "needs_human");
		assert.equal(result.residualRisks.length, 1);
		assert.equal(result.residualRisks[0].blocks, true);
		assert.match(result.residualRisks[0].text, /deep review of "h1" failed/);
	});
}

test("critic ledger: a model residual cannot hide a same-text infrastructure failure", async (t) => {
	const failureText = 'deep review of "h1" failed (malformed review output: summary missing or not a string); 1 file(s) not deep-reviewed';
	const model = candidateReview({ findings: [], residual_risks: [{ text: failureText, blocks: false }] });
	const { repo } = installStub(t, (log) => largePathBin(
		log,
		model,
		"fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: parsed.residual_risks.map(risk => ({ ...risk, blocks: false })) }));",
	).replace(
		"hotspots: [{ name: 'h1', files: ['src/app.ts'], why: 'changed', risk: 'high', edges: [] }]",
		"hotspots: ['h1', 'h2'].map(name => ({ name, files: ['src/app.ts'], why: 'changed', risk: 'high', edges: [] }))",
	).replace(
		`fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(model))});`,
		`if (input.includes('"name": "h1"')) { fs.writeFileSync(out, '{}'); return; } fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(model))});`,
	));
	const result = await review(makeBundle(repo, true));
	assert.equal(result.verdict, "needs_human");
	assert.deepEqual(result.residualRisks, [{ text: failureText, blocks: true }]);
});

for (const deep of [false, true]) {
	test(`critic ledger: ${deep ? "large" : "small"} critic infrastructure failure rejects`, async (t) => {
		const pipeline = deep ? largePathBin : smallPathBin;
		const { repo } = installStub(t, (log) => pipeline(log, candidateReview({ findings: [] }),
			"process.stderr.write('critic unavailable'); process.exit(3);",
		));
		await assert.rejects(() => review(makeBundle(repo, deep)), /codex runner exited 3/);
	});
}

test("critic ledger: map infrastructure failure rejects before critic", async (t) => {
	const { repo, calls } = installStub(t, (log) => largePathBin(log, candidateReview(), ECHO).replace(
		"if (input.includes('review-MAP pass')) {",
		"if (input.includes('review-MAP pass')) { process.stderr.write('map unavailable'); process.exit(3);",
	));
	await assert.rejects(() => review(makeBundle(repo, true)), /codex runner exited 3/);
	assert.equal(existsSync(calls), false);
});

test("critic ledger: small path accepts residual case/whitespace drift and restores candidate text", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "Need human", blocks: false }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: [{ text: "NEED   human", blocks: false }] }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.residualRisks, [
		{ text: "Need human", blocks: false },
	]);
});

test("critic ledger: small path restores candidate residuals on wording drift", async (t) => {
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({
				findings: [],
				residual_risks: [{ text: "Need human", blocks: false }],
			}),
			'fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: [{ text: "Need a human reviewer", blocks: false }] }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.deepEqual(result.residualRisks, [
		{ text: "Need human", blocks: false },
	]);
});

test("critic ledger: a late residual mismatch restores the complete candidate list", async (t) => {
	const candidateResiduals = [
		{ text: "first", blocks: false },
		{ text: "second", blocks: true },
	];
	const { repo } = installStub(t, (log) =>
		smallPathBin(
			log,
			candidateReview({ findings: [], residual_risks: candidateResiduals }),
			'fs.writeFileSync(out, JSON.stringify({ ...ledger, residual_risks: [parsed.residual_risks[0], { text: "invented", blocks: false }] }));',
		),
	);

	const result = await review(makeBundle(repo, false));
	assert.equal(result.verdict, "needs_human");
	assert.deepEqual(result.residualRisks, candidateResiduals);
});


for (const deep of [false, true]) {
	test(`critic ledger: ${deep ? "large" : "small"} materialized traces preserve every model-admitted candidate field`, async (t) => {
		const candidate = {
			...FINDING,
			consumerFile: "src/consumer.ts", consumerLine: 7,
			quote: "const value = changed();",
			replacement: { lines: ["const value = fixed();"] },
			externalClaims: [{ claim: "Optional external context", necessary: false, source: { type: "external", url: "https://spec.example.invalid/reference" } }],
		};
		const pipeline = deep ? largePathBin : smallPathBin;
		const events: ReviewTraceEvent[] = [];
		const { repo } = installStub(t, log => pipeline(log, candidateReview({ findings: [candidate] }),
			"fs.writeFileSync(out, JSON.stringify({ ...ledger, decisions: [{ ref: 'f0', action: 'keep', severity: 'P1', confidence: 0.8 }] }));"));
		const result = await review(makeBundle(repo, deep), {}, event => { events.push(event); });
		const materialized = events.filter(event => event.surface === "final_finding");
		assert.equal(materialized.length, 1);
		assert.deepEqual(JSON.parse(materialized[0].content), { ...candidate, severity: "P1", confidence: 0.8 });
		assert.equal(result.verdict, "changes_requested");
		assert.equal("ref" in result.findings[0], false);
		assert.equal("decisions" in result, false);
		assert.ok(events.some(event => event.surface === "raw_success" && event.passKind === "critic" && event.content.includes('"decisions"')));
		assert.equal(materialized[0].content.includes('"ref"'), false);
	});
	test(`critic ledger: ${deep ? "large" : "small"} interleaves keep/drop in output order`, async (t) => {
		const candidates = ["First", "Second", "Third"].map(title => ({ ...FINDING, title }));
		const pipeline = deep ? largePathBin : smallPathBin;
		const { repo } = installStub(t, log => pipeline(log, candidateReview({ findings: candidates }),
			"fs.writeFileSync(out, JSON.stringify({ ...ledger, decisions: [{ref:'f2',action:'keep',severity:'P1',confidence:0.8},{ref:'f0',action:'drop'},{ref:'f1',action:'keep',severity:'P3',confidence:1}] }));"));
		const result = await review(makeBundle(repo, deep));
		assert.deepEqual(result.findings.map(f => [f.title, f.severity, f.confidence]), [["Third", "P1", 0.8], ["Second", "P3", 1]]);
	});
}

test("critic ledger: small identical candidates retain separate refs", async (t) => {
	const { repo } = installStub(t, log => smallPathBin(log, candidateReview({ findings: [FINDING, FINDING] }),
		"fs.writeFileSync(out, JSON.stringify({ ...ledger, decisions: [{ref:'f1',action:'keep',severity:'P0',confidence:1},{ref:'f0',action:'keep',severity:'P3',confidence:0}] }));"));
	const result = await review(makeBundle(repo, false));
	assert.deepEqual(result.findings.map(f => [f.title, f.severity]), [["Echo bug", "P0"], ["Echo bug", "P3"]]);
});

test("critic ledger: large refs are assigned after candidate deduplication", async (t) => {
	const { repo } = installStub(t, log => largePathBin(log, candidateReview({ findings: [FINDING, FINDING] }),
		"if (parsed.findings.length !== 1 || parsed.findings[0].ref !== 'f0') process.exit(2); fs.writeFileSync(out, JSON.stringify(ledger));"));
	const result = await review(makeBundle(repo, true));
	assert.deepEqual(result.findings.map(f => [f.title, f.lineStart]), [["Echo bug", 1]]);
});
