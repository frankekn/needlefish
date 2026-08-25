// Resident property suite for the Class D gate contract (AGENTS.md EVAL
// DISCIPLINE): for any critic output, the pipeline either rejects outright or
// succeeds with final findings/residuals drawn only from the candidate bag.
// Pure wording drift must never abort a review — this is the regression class
// that produced the production "residual risk was not in the candidate review"
// crashes (PR #997 head bcc7ea6c4, PR #1011 head 02c4b310b).
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "./review";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle } from "../shared/schema";

const CANDIDATE_FINDINGS = [
	{
		severity: "P1",
		title: "Null deref on empty payload",
		category: "bug",
		file: "src/a.ts",
		lineStart: 10,
		lineEnd: 12,
		confidence: 0.9,
		whyItBreaks: "empty body crashes the handler",
		suggestedFix: "guard the length",
		validation: "pnpm test",
	},
	{
		severity: "P2",
		title: "Unbounded retry loop",
		category: "bug",
		file: "src/b.ts",
		lineStart: 40,
		lineEnd: 44,
		confidence: 0.8,
		whyItBreaks: "retry without backoff exhausts quota",
		suggestedFix: "cap retries with jitter",
		validation: "pnpm test",
	},
	{
		severity: "P3",
		title: "Log line leaks endpoint path",
		category: "security",
		file: "src/c.ts",
		lineStart: 77,
		lineEnd: 77,
		confidence: 0.7,
		whyItBreaks: "request paths land in shared logs",
		suggestedFix: "redact before writing",
		validation: "pnpm lint",
	},
];

const CANDIDATE_RESIDUALS = [
	{ text: "deep pass could not execute repo scripts", blocks: false },
	{ text: "review covered only the diff, not callers", blocks: true },
];

function makeBundle(repo: string): Bundle {
	return {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: false,
		focus: null,
	};
}

function candidateReview(): Record<string, unknown> {
	return {
		summary: "candidate review",
		findings: structuredClone(CANDIDATE_FINDINGS),
		checked: ["looked at src/a.ts"],
		residual_risks: structuredClone(CANDIDATE_RESIDUALS),
	};
}

function installStub(
	t: { after: (fn: () => void) => void },
	build: () => string,
): { repo: string } {
	const tmp = mkdtempSync(
		path.join(os.tmpdir(), "needlefish-residual-provenance-"),
	);
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
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
		else delete process.env.NEEDLEFISH_EVAL_TRACE;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(bin, build());
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	delete process.env.NEEDLEFISH_EVAL_TRACE;
	return { repo };
}

function smallPathBin(reviewJson: unknown, criticJs: string): string {
	return [
		"#!/usr/bin/env node",
		"const fs = require('node:fs');",
		"let input = '';",
		"process.stdin.setEncoding('utf8');",
		"process.stdin.on('data', (chunk) => { input += chunk; });",
		"process.stdin.on('end', () => {",
		"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
		"  if (input.includes('adversarial critic')) {",
		"    const parsed = JSON.parse(input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat')));",
		`    ${criticJs}`,
		"    return;",
		"  }",
		`  fs.writeFileSync(out, ${JSON.stringify(JSON.stringify(reviewJson))});`,
		"});",
	].join("\n");
}

const ECHO = "fs.writeFileSync(out, JSON.stringify(parsed));";

interface DriftCase {
	label: string;
	criticJs: string;
	exactResidualRestore?: boolean;
	expectFindingCount?: number;
}

const DRIFT_CASES: readonly DriftCase[] = [
	{ label: "echo", criticJs: ECHO },
	{
		label: "paraphrased titles and why lines across all findings",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f, i) => ({ ...f, title: ['completely different wording alpha', 'unrelated phrasing beta', 'other words gamma'][i], whyItBreaks: ['no shared tokens here', 'nothing in common', 'a distinct sentence'][i] })) }));",
	},
	{
		label: "residual fully reworded after an earlier match",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: [parsed.residual_risks[0], { text: 'entirely unrelated residual wording', blocks: false }] }));",
		exactResidualRestore: true,
	},
	{
		label: "middle finding dropped",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.filter((_, i) => i !== 1) }));",
		expectFindingCount: 2,
	},
	{
		label: "all findings pruned",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [] }));",
		expectFindingCount: 0,
	},
	{
		label: "one residual legitimately dropped",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, residual_risks: parsed.residual_risks.slice(1) }));",
	},
	{
		label: "severity corrections in both directions",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, severity: f.severity === 'P2' ? 'P3' : f.severity === 'P3' ? 'P2' : f.severity })) }));",
	},
	{
		label: "line drift within the window",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f, i) => ({ ...f, lineStart: [11, 42, 75][i] })) }));",
	},
	{
		label: "findings reordered",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [...parsed.findings].reverse() }));",
	},
];

for (const {
	label,
	criticJs,
	exactResidualRestore,
	expectFindingCount,
} of DRIFT_CASES) {
	test(`gate class D invariant: drift survives inside the candidate bag — ${label}`, async (t) => {
		const base = candidateReview();
		const { repo } = installStub(t, () => smallPathBin(base, criticJs));

		const result = await review(makeBundle(repo));
		if (expectFindingCount !== undefined) {
			assert.equal(result.findings.length, expectFindingCount);
		}
		const candidates = base.findings as Record<string, unknown>[];
		for (const finding of result.findings) {
			const restored = candidates.some(
				(c) =>
					c.file === finding.file &&
					c.category === finding.category &&
					c.lineStart === finding.lineStart &&
					c.title === finding.title &&
					c.whyItBreaks === finding.whyItBreaks &&
					c.suggestedFix === finding.suggestedFix &&
					c.validation === finding.validation,
			);
			assert.ok(
				restored,
				`final finding must carry restored candidate content, got: ${finding.title}`,
			);
		}
		const residualTexts = new Set(
			(base.residual_risks as Record<string, unknown>[]).map((r) => r.text),
		);
		for (const risk of result.residualRisks) {
			assert.ok(
				residualTexts.has(risk.text),
				`final residual must come from the candidate bag, got: ${risk.text}`,
			);
		}
		if (exactResidualRestore) {
			assert.deepEqual(
				result.residualRisks.map((r) => ({ text: r.text, blocks: r.blocks })),
				base.residual_risks,
			);
		}
	});
}

const REJECT_CASES: readonly { label: string; criticJs: string }[] = [
	{
		label: "invented finding",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [...parsed.findings, { severity: 'P0', title: 'invented marker', category: 'security', file: 'src/invented.ts', lineStart: 99, lineEnd: 99, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' }] }));",
	},
	{
		label: "duplicated finding beyond candidate multiplicity",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: [...parsed.findings, parsed.findings[0]] }));",
	},
	{
		label: "rewritten file axis",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, file: 'src/moved.ts' })) }));",
	},
	{
		label: "rewritten category axis",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f) => ({ ...f, category: 'contract' })) }));",
	},
	{
		label: "line drift outside the window",
		criticJs:
			"fs.writeFileSync(out, JSON.stringify({ ...parsed, findings: parsed.findings.map((f, i) => ({ ...f, lineStart: [13, 43, 80][i], lineEnd: [15, 47, 80][i] })) }));",
	},
];

for (const { label, criticJs } of REJECT_CASES) {
	test(`gate class D invariant: identity break still rejects — ${label}`, async (t) => {
		const { repo } = installStub(t, () =>
			smallPathBin(candidateReview(), criticJs),
		);

		await assert.rejects(
			() => review(makeBundle(repo)),
			/malformed critic output: finding was not in the candidate review/,
		);
	});
}
