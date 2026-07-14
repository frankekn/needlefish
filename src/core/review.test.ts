import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "./review";
import type { ReviewTraceEvent } from "./review-trace";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle } from "../shared/schema";

test("review preserves deep evidence through tail coverage", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	process.env.NEEDLEFISH_EVAL_TRACE = "1";
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  const finding = { severity: 'P2', title: 'Deep bug', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'The changed path breaks.', suggestedFix: 'Fix the path.', validation: 'pnpm test' };",
			"  const evidence = 'EVIDENCE finding:Deep bug changed=src/app.ts:1 effect=bad path';",
			"  if (input.includes('review-MAP pass')) {",
			"    if (!input.includes('Review body') || !input.includes('review comment')) { process.stderr.write('missing map PR metadata'); process.exit(1); }",
			// The canary lands ONLY in the map hotspot's why — text that is
			// consumed for hotspot selection but never retained in ReviewResult.
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'consumer', files: ['src/unchanged.ts'], why: 'consumer only CANARY-TOKEN-XYZ', risk: 'high', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			"    if (!input.includes('tail-coverage') || !input.includes('src/app.ts')) { process.stderr.write('missing tail coverage'); process.exit(1); }",
			"    if (!input.includes('Review body') || !input.includes('review comment')) { process.stderr.write('missing deep PR metadata'); process.exit(1); }",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'deep found blocker', findings: [finding], checked: [evidence], residual_risks: [] }));",
			"    return;",
			"  }",
			"  if (input.includes('adversarial critic')) {",
			"    if (!input.includes(evidence)) { process.stderr.write('missing deep evidence'); process.exit(1); }",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'critic kept blocker', findings: [finding], checked: [evidence], residual_risks: [] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: {
			number: 123,
			title: "PR title",
			body: "Review body",
			comments: ["review comment"],
			reviews: [],
			checks: [],
		},
		deep: true,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "changes_requested");
	assert.deepEqual(result.checked, [
		"EVIDENCE finding:Deep bug changed=src/app.ts:1 effect=bad path",
	]);
	// S5: coverage string counts the tail backstop hotspot that deep-reviewed
	// the one changed file the map pass left uncovered.
	assert.equal(
		result.coverage,
		"1/1 changed files deep-reviewed across 1 hotspot, incl. tail-coverage",
	);
	// Successful pass outputs are retained under eval tracing: the map's
	// hotspot text is consumed for selection but never lands in the final
	// result — the canary scan needs the full transcript.
	assert.ok(
		result.rawOutputs?.some((raw) => raw.includes("CANARY-TOKEN-XYZ")),
		"successful map output must be retained for the canary scan",
	);
});

test("review attaches map transcripts when concurrency validation fails", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.txt");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
		trace: process.env.NEEDLEFISH_EVAL_TRACE,
		concurrency: process.env.NEEDLEFISH_DEEP_CONCURRENCY,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		if (previous.concurrency === undefined)
			delete process.env.NEEDLEFISH_DEEP_CONCURRENCY;
		else process.env.NEEDLEFISH_DEEP_CONCURRENCY = previous.concurrency;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  if (input.includes('review-MAP pass')) {",
			`    fs.appendFileSync(${JSON.stringify(calls)}, 'map\\n');`,
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'changed', files: ['src/app.ts'], why: 'CANARY-CONCURRENCY-MAP-XYZ', risk: 'high', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			`    fs.appendFileSync(${JSON.stringify(calls)}, 'deep\\n');`,
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'deep clean', findings: [], checked: ['looked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";
	process.env.NEEDLEFISH_DEEP_CONCURRENCY = "0";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: true,
		focus: null,
	};

	const events: ReviewTraceEvent[] = [];
	const rejection = await review(
		bundle,
		{},
		(event: ReviewTraceEvent) => events.push(event),
	).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "invalid concurrency must reject");
	assert.match(
		rejection.message,
		/NEEDLEFISH_DEEP_CONCURRENCY requires a positive integer/,
	);
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	assert.ok(
		raws?.some((raw) => raw.includes("CANARY-CONCURRENCY-MAP-XYZ")),
		"successful map transcript must ride the concurrency rejection",
	);
	assert.ok(
		events.some(
			(event) =>
				event.passKind === "map" &&
				event.surface === "candidate_review_text" &&
				event.content.includes("mapped"),
		),
		"the parsed map trace must survive the later concurrency error",
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["map"]);
});

test("review aborts deep fallback when a non-codex runner dirties the sandbox", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "claude-bin.js");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		trace: process.env.NEEDLEFISH_EVAL_TRACE,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	process.env.NEEDLEFISH_EVAL_TRACE = "1";
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  if (input.includes('review-MAP pass')) {",
			"    process.stdout.write(JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'changed', files: ['src/app.ts'], why: 'changed file', risk: 'high', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			"    fs.writeFileSync('runner-wrote.txt', 'dirty');",
			// The output emitted before the violation carries the bait: dirtying
			// the sandbox must not launder it out of the canary scan.
			"    process.stdout.write(JSON.stringify({ summary: 'deep CANARY-TOKEN-XYZ', findings: [], checked: ['deep checked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: true,
		focus: null,
	};

	const rejection = await review(bundle, {
		runner: "claude",
		timeoutMs: 1000,
	}).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "sandbox violation must reject");
	assert.match(
		rejection.message,
		/claude runner changed the review sandbox worktree/,
	);
	// Emit-then-dirty is not an escape hatch: the output produced before the
	// violation rides the safety error into the eval canary scan.
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	assert.ok(
		raws?.some((raw) => raw.includes("CANARY-TOKEN-XYZ")),
		"output emitted before the sandbox violation must ride the rejection",
	);
});

test("review keeps deep failure residuals after critic pruning", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  if (input.includes('review-MAP pass')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'changed', files: ['src/app.ts'], why: 'changed file', risk: 'high', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			"    fs.writeFileSync(out, 'not json');",
			"    return;",
			"  }",
			"  if (input.includes('adversarial critic')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'critic pruned', findings: [], checked: ['critic checked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: true,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "needs_human");
	assert.match(
		result.residualRisks[0]?.text ?? "",
		/deep review of "changed" failed/,
	);
	// Coverage must NOT count the failed hotspot's files as deep-reviewed:
	// the single hotspot failed, so 0/1 — an overstated coverage line would
	// contradict the blocking residual right below it.
	assert.match(
		result.coverage ?? "",
		/^0\/1 changed files deep-reviewed across 0 hotspots/,
	);
});

test("review treats a degenerate deep response as a failed pass", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  if (input.includes('review-MAP pass')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'changed', files: ['src/app.ts'], why: 'changed file', risk: 'high', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			// Valid JSON shape, zero evidence: empty summary AND empty checked.
			// normalizeReview accepts this; only the usability gate rejects it.
			"    fs.writeFileSync(out, JSON.stringify({ summary: '', findings: [], checked: [], residual_risks: [] }));",
			"    return;",
			"  }",
			"  if (input.includes('adversarial critic')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'critic pruned', findings: [], checked: ['critic checked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: true,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "needs_human");
	assert.match(
		result.residualRisks[0]?.text ?? "",
		/deep review of "changed" failed/,
	);
	// A response with no summary and no checked list is not deep-review
	// evidence — its hotspot must be excluded from coverage, same as a crash.
	assert.match(
		result.coverage ?? "",
		/^0\/1 changed files deep-reviewed across 0 hotspots/,
	);
});

test("review re-asks once when the model emits malformed JSON", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`  const calls = ${JSON.stringify(calls)};`,
			"  const review = { summary: 'clean', findings: [], checked: ['looked at diff'], residual_risks: [] };",
			"  if (input.includes('adversarial critic')) {",
			"    fs.appendFileSync(calls, 'critic\\n');",
			"    fs.writeFileSync(out, JSON.stringify(review));",
			"    return;",
			"  }",
			"  fs.appendFileSync(calls, 'review\\n');",
			"  const reviews = fs.readFileSync(calls, 'utf8').split('\\n').filter((line) => line === 'review').length;",
			"  fs.writeFileSync(out, reviews === 1 ? 'not json at all CANARY-TOKEN-XYZ' : JSON.stringify(review));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
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

	const result = await review(bundle);

	assert.equal(result.verdict, "pass");
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review",
		"review",
		"critic",
	]);
	assert.deepEqual(
		result.stats?.map((s) => s.label),
		["review", "review", "critic"],
	);
	assert.ok(
		result.stats?.every((s) => s.ok && s.attempts === 1 && s.durationMs > 0),
	);
	assert.ok((result.totalDurationMs ?? 0) > 0);
	// A successful retry is not an escape hatch: the malformed FIRST attempt
	// (carrying the canary) must still surface for the eval scan.
	assert.equal(result.failedRawOutputs?.length, 1);
	assert.ok(
		result.failedRawOutputs?.[0]?.includes("CANARY-TOKEN-XYZ"),
		"contaminated first attempt must survive a clean successful retry",
	);
});

test("review fails after a second malformed response", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		trace: process.env.NEEDLEFISH_EVAL_TRACE,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`  fs.appendFileSync(${JSON.stringify(calls)}, 'review\\n');`,
			// First attempt leaks the canary; the retry is malformed but clean —
			// BOTH must be preserved on the rejection for the eval scan.
			`  const n = fs.readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length;`,
			"  fs.writeFileSync(out, n === 1 ? 'not json CANARY-TOKEN-XYZ' : 'still not json, clean retry');",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
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

	const events: ReviewTraceEvent[] = [];
	const rejection = await review(
		bundle,
		{},
		(event: ReviewTraceEvent) => events.push(event),
	).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(
		rejection instanceof Error,
		"second malformed response must reject",
	);
	assert.match(rejection.message, /no JSON object found/);
	// EVERY failed attempt's raw output rides along on the error so the eval
	// canary scan can inspect them — a contaminated first attempt followed by
	// a cleaner malformed retry is not an escape hatch.
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	// Both failed attempts must be preserved (the run-level accumulators also
	// carry each status-0 attempt's full stream transcript via onRaw, so the
	// list is a superset — assert content, not count).
	assert.ok(
		raws?.some((raw) => raw.includes("still not json, clean retry")),
		"the clean second attempt must be preserved",
	);
	assert.ok(
		raws?.[0]?.includes("CANARY-TOKEN-XYZ"),
		"the contaminated first attempt must be present",
	);
	assert.deepEqual(
		events
			.filter(
				(event) =>
					event.passKind === "review" &&
					event.surface === "raw_success" &&
					event.outcome === "parse_failed",
			)
			.map((event) => event.promptAttempt),
		[1, 2],
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review",
		"review",
	]);
});

test("a runner that emits output then exits nonzero still feeds the canary scan", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			// Emit the bait, then die: crashing must not launder the emitted text
			// out of the scan. The stderr bait sits past the 2000-char clip the
			// error MESSAGE applies — the rider must carry stderr untruncated.
			"  process.stdout.write('leaked before crash CANARY-TOKEN-XYZ');",
			"  process.stderr.write('x'.repeat(2500) + ' CANARY-STDERR-QRS');",
			"  process.exit(3);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
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

	const rejection = await review(bundle).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "nonzero runner exit must reject");
	assert.match(rejection.message, /runner exited 3/);
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	assert.ok(
		raws?.some((raw) => raw.includes("CANARY-TOKEN-XYZ")),
		"stdout captured before the crash must ride the rejection",
	);
	assert.ok(
		raws?.some((raw) => raw.includes("CANARY-STDERR-QRS")),
		"stderr past the message clip must ride the rejection untruncated",
	);

	// Without eval tracing (prod), the run must NOT retain failure
	// transcripts at all — no accumulation toward an OOM, no transcript
	// fields riding errors the adapters might surface.
	delete process.env.NEEDLEFISH_EVAL_TRACE;
	const prodRejection = await review(bundle).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(prodRejection instanceof Error, "nonzero exit must still reject");
	assert.equal(
		(prodRejection as Error & { rawOutputs?: readonly string[] }).rawOutputs,
		undefined,
		"failure transcripts must not be retained without eval tracing",
	);
});

test("a status-0 runner's stdout and stderr reach the canary scan alongside its clean output", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			// Success is not an escape hatch: the model output is clean, the
			// bait rides only the raw process streams of a status-0 attempt.
			"  process.stdout.write('stream noise CANARY-STDOUT-OK');",
			"  process.stderr.write('stream noise CANARY-STDERR-OK');",
			"  fs.writeFileSync(out, JSON.stringify({ summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] }));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
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

	const result = await review(bundle);
	assert.equal(result.verdict, "pass");
	for (const canary of ["CANARY-STDOUT-OK", "CANARY-STDERR-OK"]) {
		assert.ok(
			result.rawOutputs?.some((raw) => raw.includes(canary)),
			`${canary} from a successful attempt's stream must reach the scan`,
		);
	}
});

test("a deep pass crash waits for concurrent siblings before snapshotting transcripts", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  if (input.includes('review-MAP pass')) {",
			// Two hotspots so the deep stage runs concurrently: 'dies' rejects
			// fast with a SAFETY error (dirties the sandbox worktree — plain
			// nonzero exits are swallowed into residuals and would not reject),
			// 'slow' emits the canary in a SUCCESSFUL response 500ms later.
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'dies', files: ['src/app.ts'], why: 'crashy', risk: 'high', edges: [] }, { name: 'slow', files: ['src/app.ts'], why: 'slow sibling', risk: 'med', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			"    if (input.includes('\"dies\"')) {",
			"      fs.writeFileSync('runner-wrote.txt', 'dirty');",
			"      fs.writeFileSync(out, JSON.stringify({ summary: 'dies done', findings: [], checked: ['dies checked'], residual_risks: [] }));",
			"      process.exit(0);",
			"    }",
			"    setTimeout(() => {",
			"      fs.writeFileSync(out, JSON.stringify({ summary: 'slow sibling done CANARY-SIBLING-B', findings: [], checked: ['slow checked'], residual_risks: [] }));",
			"      process.exit(0);",
			"    }, 500);",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: true,
		focus: null,
	};

	const events: ReviewTraceEvent[] = [];
	const rejection = await review(
		bundle,
		{},
		(event: ReviewTraceEvent) => events.push(event),
	).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "the crashing deep pass must reject");
	assert.match(
		rejection.message,
		/runner changed the review sandbox worktree/,
	);
	// The terminal snapshot is refreshed AFTER the worker pool drains: the
	// slow sibling's output — emitted after the first rejection — must be in
	// it, or emit-while-a-sibling-dies becomes a canary escape hatch.
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	assert.ok(
		raws?.some((raw) => raw.includes("CANARY-SIBLING-B")),
		"a sibling transcript emitted after the first rejection must ride the terminal error",
	);
	assert.ok(
		events.some(
			(event) =>
				event.passKind === "deep" &&
				event.passIndex === 1 &&
				event.surface === "candidate_review_text" &&
				event.content.includes("slow sibling done"),
		),
		"the drained sibling's parsed trace must remain observable",
	);
});

test("canary written only to the output file of a crashed runner still feeds the scan", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			// codex resolves its model output from --output-last-message, not
			// stdout: the bait lands ONLY in that file before the nonzero exit.
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  fs.writeFileSync(out, 'final message CANARY-TOKEN-XYZ');",
			"  process.exit(2);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
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

	const rejection = await review(bundle).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "nonzero runner exit must reject");
	assert.match(rejection.message, /runner exited 2/);
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	assert.ok(
		raws?.some((raw) => raw.includes("CANARY-TOKEN-XYZ")),
		"the resolved output file of a crashed runner must ride the rejection",
	);
});

test("terminal error carries failed raws from earlier passes whose retry succeeded", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
	process.env.NEEDLEFISH_EVAL_TRACE = "1";
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`  const calls = ${JSON.stringify(calls)};`,
			"  const review = { summary: 'clean', findings: [], checked: ['looked at diff'], residual_risks: [] };",
			// Critic fails BOTH attempts with clean malformed text — the terminal
			// rejection must still expose the review pass's contaminated attempt.
			"  if (input.includes('adversarial critic')) {",
			"    fs.appendFileSync(calls, 'critic\\n');",
			"    fs.writeFileSync(out, 'critic not json, clean');",
			"    return;",
			"  }",
			"  fs.appendFileSync(calls, 'review\\n');",
			"  const reviews = fs.readFileSync(calls, 'utf8').split('\\n').filter((line) => line === 'review').length;",
			"  fs.writeFileSync(out, reviews === 1 ? 'not json CANARY-TOKEN-XYZ' : JSON.stringify(review));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	const bundle: Bundle = {
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

	const rejection = await review(bundle).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "critic double failure must reject");
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review",
		"review",
		"critic",
		"critic",
	]);
	// Run-level snapshot: the review pass's contaminated first attempt, both
	// critic attempts, AND (trace on) the successful review retry — neither a
	// successful mid-run retry nor a successful pass is an escape hatch.
	const raws = (rejection as Error & { rawOutputs?: readonly string[] })
		.rawOutputs;
	// The list is a superset now that every status-0 attempt also lands its
	// full stream transcript via onRaw — assert the required members, not
	// an exact count.
	assert.ok((raws?.length ?? 0) >= 4, "all attempt transcripts must ride");
	assert.ok(
		raws?.[0]?.includes("CANARY-TOKEN-XYZ"),
		"earlier pass's contaminated attempt must survive its own successful retry",
	);
	assert.ok(
		raws?.some((raw) => raw.includes('"summary":"clean"')),
		"the successful pass transcript must ride terminal errors too",
	);
});

test("review does not re-ask after a runner safety error", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "claude-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = process.env.CLAUDE_BIN;
	t.after(() => {
		if (previous === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			`  fs.appendFileSync(${JSON.stringify(calls)}, 'review\\n');`,
			"  fs.writeFileSync('runner-wrote.txt', 'dirty');",
			"  process.stdout.write(JSON.stringify({ summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] }));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;

	const bundle: Bundle = {
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

	await assert.rejects(
		() => review(bundle, { runner: "claude", timeoutMs: 5000 }),
		/claude runner changed the review sandbox worktree/,
	);
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), ["review"]);
});

test("review isolates trace observers across concurrent deep passes and classifies critic output as final only", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
		concurrency: process.env.NEEDLEFISH_DEEP_CONCURRENCY,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		if (previous.concurrency === undefined)
			delete process.env.NEEDLEFISH_DEEP_CONCURRENCY;
		else process.env.NEEDLEFISH_DEEP_CONCURRENCY = previous.concurrency;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			`const tmp = ${JSON.stringify(tmp)};`,
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  if (input.includes('review-MAP pass')) {",
			`    fs.appendFileSync(${JSON.stringify(calls)}, 'map\\n');`,
			"    const hotspot = (name, file) => ({ name, files: [file], why: 'changed', risk: 'high', edges: [] });",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [hotspot('h1', 'src/a.ts'), hotspot('h2', 'src/b.ts'), hotspot('h3', 'src/c.ts')] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			'    const name = /"name": "(h\\d)"/.exec(input)[1];',
			`    fs.appendFileSync(${JSON.stringify(calls)}, \`deep-\${name}\\n\`);`,
			"    const delays = { h1: 800, h2: 500, h3: 200 };",
			"    const start = Date.now();",
			"    setTimeout(() => {",
			"      const finding = { severity: 'P2', title: `deep candidate marker ${name}`, category: 'bug', file: `src/${name}.ts`, lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' };",
			"      fs.writeFileSync(path.join(tmp, `deep-${name}.json`), JSON.stringify({ start, end: Date.now() }));",
			"      fs.writeFileSync(out, JSON.stringify({ summary: `deep ${name}`, findings: [finding], checked: [`checked ${name}`], residual_risks: [] }));",
			"    }, delays[name]);",
			"    return;",
			"  }",
			"  if (input.includes('adversarial critic')) {",
			`    fs.appendFileSync(${JSON.stringify(calls)}, 'critic\\n');`,
			"    const candidate = input.slice(input.indexOf('# Candidate findings') + '# Candidate findings'.length, input.indexOf('# Diff stat'));",
			"    if (candidate.includes('observer-mutated')) { process.stderr.write('observer mutated critic input'); process.exit(1); }",
			"    const parsed = JSON.parse(candidate);",
			"    const finding = { severity: 'P2', title: 'critic-only marker', category: 'bug', file: 'src/a.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' };",
			"    fs.writeFileSync(out, JSON.stringify({ ...parsed, summary: 'critic-only marker', findings: [finding] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_DEEP_CONCURRENCY = "3";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/a.ts | 1 +",
		changedFiles: [
			{ path: "src/a.ts", surface: "source" },
			{ path: "src/b.ts", surface: "source" },
			{ path: "src/c.ts", surface: "source" },
		],
		agentsMd: "(none)",
		prMeta: null,
		deep: true,
		focus: null,
	};

	const baseline = await review(bundle);
	const events: ReviewTraceEvent[] = [];
	const result = await review(
		bundle,
		{},
		(event: ReviewTraceEvent) => {
			events.push(event);
			Reflect.set(event, "passIndex", 99);
			if (
				event.surface === "candidate_finding" ||
				event.surface === "final_finding"
			) {
				Reflect.set(event.finding, "title", "observer-mutated");
				Reflect.set(event.finding, "severity", "P3");
			}
			throw new Error("observer delivery failed");
		},
	);

	assert.deepEqual(
		{
			verdict: result.verdict,
			summary: result.summary,
			findings: result.findings,
			checked: result.checked,
			residualRisks: result.residualRisks,
			coverage: result.coverage,
		},
		{
			verdict: baseline.verdict,
			summary: baseline.summary,
			findings: baseline.findings,
			checked: baseline.checked,
			residualRisks: baseline.residualRisks,
			coverage: baseline.coverage,
		},
	);
	assert.deepEqual(result.checked, [
		"[h1] deep h1",
		"checked h1",
		"[h2] deep h2",
		"checked h2",
		"[h3] deep h3",
		"checked h3",
	]);
	const windows = ["h1", "h2", "h3"].map(
		(name) =>
			JSON.parse(readFileSync(path.join(tmp, `deep-${name}.json`), "utf8")) as {
				start: number;
				end: number;
			},
	);
	const overlaps = windows.some((a, i) =>
		windows.some((b, j) => i < j && a.start < b.end && b.start < a.end),
	);
	assert.ok(overlaps, "expected at least two deep passes to overlap in time");
	assert.equal(
		readFileSync(calls, "utf8").trim().split("\n").length,
		10,
		"observer delivery errors must not add model calls",
	);
	assert.equal(
		result.traceDeliveryFailed,
		true,
		"observer throws must mark delivery health failed",
	);
	for (const [marker, passIndex] of [
		["deep h1", 0],
		["deep h2", 1],
		["deep h3", 2],
	] as const) {
		assert.ok(
			events.some(
				(event) =>
					event.passKind === "deep" &&
					event.passIndex === passIndex &&
					event.surface === "candidate_review_text" &&
					event.content.includes(marker),
			),
			`${marker} must retain source index ${passIndex}`,
		);
	}
	const deepFindingEvent = events.find(
		(event) =>
			event.surface === "candidate_finding" &&
			event.content.includes("deep candidate marker h1"),
	);
	assert.equal(deepFindingEvent?.finding?.title, "deep candidate marker h1");
	assert.equal(
		events.filter(
			(event) =>
				event.surface.startsWith("candidate_") &&
				event.content.includes("critic-only marker"),
		).length,
		0,
		"critic-only output must never be emitted as a candidate surface",
	);
	assert.ok(
		events.some(
			(event) =>
				event.surface === "final_finding" &&
				event.content.includes("critic-only marker"),
		),
	);
	assert.ok(
		events.some(
			(event) =>
				event.surface === "final_review_text" &&
				event.content.includes("critic-only marker"),
		),
	);
	assert.ok(
		events.some(
			(event) =>
				event.surface === "candidate_finding" &&
				event.content.includes("deep candidate marker"),
		),
		"pre-critic deep output must remain a candidate",
	);
	assert.equal(
		events.filter(
			(event) =>
				event.surface.startsWith("final_") &&
				event.content.includes("deep candidate marker"),
		).length,
		0,
		"critic-pruned candidate output must not survive on final surfaces",
	);
	const labels = new Set(result.stats?.map((s) => s.label));
	for (const expected of ["map", "deep:h1", "deep:h2", "deep:h3", "critic"]) {
		assert.ok(labels.has(expected), `missing stat label ${expected}`);
	}
});

test("review feeds the diff as raw text, not escaped bundle JSON", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = process.env.CODEX_BIN;
	t.after(() => {
		if (previous === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  const review = { summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] };",
			"  if (input.includes('adversarial critic')) {",
			"    fs.writeFileSync(out, JSON.stringify(review));",
			"    return;",
			"  }",
			"  if (!input.includes('===== BEGIN DIFF (base..head) =====')) { process.stderr.write('missing diff sentinel'); process.exit(1); }",
			"  if (!input.includes('diff --git a/src/app.ts b/src/app.ts\\n+const answer = 42;')) { process.stderr.write('diff not raw text'); process.exit(1); }",
			"  if (input.includes('\"patch\"')) { process.stderr.write('patch leaked into bundle json'); process.exit(1); }",
			"  fs.writeFileSync(out, JSON.stringify(review));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "diff --git a/src/app.ts b/src/app.ts\n+const answer = 42;\n",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: false,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "pass");
});

test("review large thresholds are env-overridable", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = {
		bin: process.env.CODEX_BIN,
		chars: process.env.NEEDLEFISH_LARGE_PATCH_CHARS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.chars === undefined)
			delete process.env.NEEDLEFISH_LARGE_PATCH_CHARS;
		else process.env.NEEDLEFISH_LARGE_PATCH_CHARS = previous.chars;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  if (input.includes('review-MAP pass')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'mapped', hotspots: [{ name: 'h1', files: ['src/app.ts'], why: 'changed', risk: 'high', edges: [] }] }));",
			"    return;",
			"  }",
			"  if (input.includes('doing a DEEP review')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'deep h1', findings: [], checked: ['checked h1'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  if (input.includes('adversarial critic')) {",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'critic done', findings: [], checked: ['critic checked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  process.stderr.write('unexpected prompt');",
			"  process.exit(1);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_LARGE_PATCH_CHARS = "5";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "longer than five characters",
		patchStat: " src/app.ts | 1 +",
		changedFiles: [{ path: "src/app.ts", surface: "source" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: false,
		focus: null,
	};

	const result = await review(bundle);

	const labels = result.stats?.map((s) => s.label) ?? [];
	assert.ok(
		labels.includes("map"),
		"expected the large path (map pass) to run",
	);
});

test("review docs-only fast path skips all model calls", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = process.env.CODEX_BIN;
	t.after(() => {
		if (previous === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`fs.appendFileSync(${JSON.stringify(calls)}, 'called\\n');`,
			"process.exit(1);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "diff --git a/README.md b/README.md\n+docs\n",
		patchStat: " README.md | 1 +",
		changedFiles: [
			{ path: "README.md", surface: "docs" },
			{ path: "docs/guide.md", surface: "docs" },
		],
		agentsMd: "(none)",
		prMeta: null,
		deep: false,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "pass");
	assert.deepEqual(result.findings, []);
	assert.deepEqual(result.residualRisks, []);
	assert.match(
		result.summary,
		/Docs-only change \(2 file\(s\)\); model review skipped\./,
	);
	assert.deepEqual(result.checked, [
		"FAST_PATH docs-only files=[README.md, docs/guide.md]",
	]);
	assert.equal(result.stats, undefined, "no stats when model is not called");
	assert.ok((result.totalDurationMs ?? -1) >= 0, "totalDurationMs must be set");
	assert.equal(result.baseSha, "base");
	assert.ok(
		!existsSync(calls),
		"runner must not be invoked for docs-only bundle",
	);
});

test("review mixed docs+source bundle still invokes the model", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  const review = { summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] };",
			"  fs.appendFileSync(" + JSON.stringify(calls) + ", 'x\\n');",
			"  fs.writeFileSync(out, JSON.stringify(review));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "diff --git a/README.md b/README.md\n+docs\n",
		patchStat: " README.md | 1 +",
		changedFiles: [
			{ path: "README.md", surface: "docs" },
			{ path: "src/app.ts", surface: "source" },
		],
		agentsMd: "(none)",
		prMeta: null,
		deep: false,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "pass");
	assert.ok(
		existsSync(calls),
		"runner must be invoked for mixed docs+source bundle",
	);
});

test("review NEEDLEFISH_NO_FAST_PATH disables docs-only fast path", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
		noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		if (previous.noFastPath === undefined)
			delete process.env.NEEDLEFISH_NO_FAST_PATH;
		else process.env.NEEDLEFISH_NO_FAST_PATH = previous.noFastPath;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  const review = { summary: 'clean', findings: [], checked: ['looked'], residual_risks: [] };",
			"  fs.appendFileSync(" + JSON.stringify(calls) + ", 'x\\n');",
			"  fs.writeFileSync(out, JSON.stringify(review));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_NO_FAST_PATH = "1";

	const bundle: Bundle = {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "diff --git a/README.md b/README.md\n+docs\n",
		patchStat: " README.md | 1 +",
		changedFiles: [{ path: "README.md", surface: "docs" }],
		agentsMd: "(none)",
		prMeta: null,
		deep: false,
		focus: null,
	};

	const result = await review(bundle);

	assert.equal(result.verdict, "pass");
	assert.ok(
		existsSync(calls),
		"runner must be invoked when NEEDLEFISH_NO_FAST_PATH is set",
	);
	assert.doesNotMatch(result.summary, /Docs-only change/);
});

// Small-path echo critic: the runner answers both review and critic prompts
// with the same finding. Under NEEDLEFISH_EVAL_TRACE the result must expose
// the pre-critic candidate findings; without it, the field stays absent.
function evalTraceEchoBundle(repo: string): Bundle {
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

function writeEchoCriticBin(bin: string): void {
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			"  const finding = { severity: 'P2', title: 'Echo bug', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' };",
			"  fs.writeFileSync(out, JSON.stringify({ summary: 'clean', findings: [finding], checked: ['looked'], residual_risks: [] }));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
}

test("review records candidateFindings when NEEDLEFISH_EVAL_TRACE is set (small path)", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeEchoCriticBin(bin);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const result = await review(evalTraceEchoBundle(repo));

	assert.ok(
		result.candidateFindings,
		"candidateFindings must be present under NEEDLEFISH_EVAL_TRACE",
	);
	assert.equal(result.candidateFindings!.length, 1);
	assert.equal(result.candidateFindings![0].title, "Echo bug");
	assert.equal(result.findings.length, 1);
	assert.equal(result.findings[0].title, "Echo bug");
	// S2: the small path states its coverage guarantee.
	assert.match(
		result.coverage ?? "",
		/^full diff reviewed in one pass \(\d+ files?\)$/,
	);
});

test("review omits candidateFindings when NEEDLEFISH_EVAL_TRACE is unset or '0' (small path)", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeEchoCriticBin(bin);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	// Unset AND "0" both mean OFF: only exactly "1" enables tracing (matching
	// the eval lane) — "0" must not attach transcripts to serialized results.
	for (const value of [undefined, "0"] as const) {
		if (value === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
		else process.env.NEEDLEFISH_EVAL_TRACE = value;

		const result = await review(evalTraceEchoBundle(repo));

		assert.equal(
			result.candidateFindings,
			undefined,
			`candidateFindings must be absent with NEEDLEFISH_EVAL_TRACE=${String(value)}`,
		);
		assert.equal(
			result.rawOutputs,
			undefined,
			`rawOutputs must be absent with NEEDLEFISH_EVAL_TRACE=${String(value)}`,
		);
		assert.equal(result.findings.length, 1);
	}
});

test("review traces prompt and runner attempts through candidate and final surfaces", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"let input = '';",
			"process.stdin.setEncoding('utf8');",
			"process.stdin.on('data', (chunk) => { input += chunk; });",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`  const calls = ${JSON.stringify(calls)};`,
			"  const finding = { severity: 'P2', title: 'candidate finding marker', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' };",
			"  if (input.includes('adversarial critic')) {",
			"    fs.appendFileSync(calls, 'critic\\n');",
			"    const critics = fs.readFileSync(calls, 'utf8').split('\\n').filter((line) => line === 'critic').length;",
			"    if (critics === 1) process.exit(4);",
			"    const finalFinding = { ...finding, title: 'final finding marker' };",
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'final review marker', findings: [finalFinding], checked: ['final checked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  fs.appendFileSync(calls, 'review\\n');",
			"  const count = fs.readFileSync(calls, 'utf8').trim().split('\\n').length;",
			"  if (count === 1) { fs.writeFileSync(out, 'malformed first prompt attempt'); return; }",
			"  if (count === 2) { process.stdout.write('failed runner attempt'); process.exit(3); }",
			"  fs.writeFileSync(out, JSON.stringify({ summary: 'candidate review marker', findings: [finding], checked: ['candidate checked'], residual_risks: [] }));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	const events: ReviewTraceEvent[] = [];
	const result = await review(
		{
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
		},
		{},
		(event: ReviewTraceEvent) => events.push(event),
	);

	assert.equal(result.findings[0]?.title, "final finding marker");
	assert.ok(
		events.some(
			(event) =>
				event.surface === "raw_success" &&
				event.passKind === "review" &&
				event.promptAttempt === 1 &&
				event.runnerAttempt === 1 &&
				event.outcome === "parse_failed",
		),
	);
	assert.deepEqual(
		events
			.filter((event) => event.surface === "raw_failure")
			.map((event) => ({
				content: event.content,
				passKind: event.passKind,
				promptAttempt: event.promptAttempt,
				runnerAttempt: event.runnerAttempt,
				outcome: event.outcome,
			})),
		[
			{
				content: "failed runner attempt",
				passKind: "review",
				promptAttempt: 2,
				runnerAttempt: 1,
				outcome: "runner_failed",
			},
			{
				content: "",
				passKind: "critic",
				promptAttempt: 1,
				runnerAttempt: 1,
				outcome: "runner_failed",
			},
		],
	);
	assert.ok(
		events.some(
			(event) =>
				event.surface === "raw_success" &&
				event.passKind === "review" &&
				event.promptAttempt === 2 &&
				event.runnerAttempt === 2 &&
				event.outcome === "parsed",
		),
	);
	for (const [surface, marker] of [
		["candidate_finding", "candidate finding marker"],
		["candidate_review_text", "candidate review marker"],
		["final_finding", "final finding marker"],
		["final_review_text", "final review marker"],
	] as const) {
		assert.ok(
			events.some(
				(event) => event.surface === surface && event.content.includes(marker),
			),
			`missing ${surface}`,
		);
	}
	assert.equal(
		events.filter(
			(event) =>
				event.surface.startsWith("candidate_") &&
				event.content.includes("final finding marker"),
		).length,
		0,
		"critic-only findings must not be candidate findings",
	);
	assert.equal(
		events.filter(
			(event) =>
				event.surface.startsWith("candidate_") &&
				event.content.includes("final review marker"),
		).length,
		0,
		"critic-only review text must not be candidate review text",
	);
	assert.equal(
		events.filter(
			(event) =>
				event.surface.startsWith("final_") &&
				event.content.includes("candidate finding marker"),
		).length,
		0,
		"critic-pruned candidate findings must not be final findings",
	);
	const candidateFinding = events.find(
		(event) =>
			event.surface === "candidate_finding" &&
			event.content.includes("candidate finding marker"),
	);
	const finalFinding = events.find(
		(event) =>
			event.surface === "final_finding" &&
			event.content.includes("final finding marker"),
	);
	assert.equal(candidateFinding?.finding?.title, "candidate finding marker");
	assert.equal(finalFinding?.finding?.title, "final finding marker");
});

test("review isolates observer mutation and errors from small review semantics", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const calls = path.join(tmp, "calls.log");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`  fs.appendFileSync(${JSON.stringify(calls)}, 'call\\n');`,
			"  const finding = { severity: 'P2', title: 'production finding', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'pnpm test' };",
			"  fs.writeFileSync(out, JSON.stringify({ summary: 'clean', findings: [finding], checked: ['checked'], residual_risks: [] }));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	const bundle: Bundle = {
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
	const baseline = await review(bundle);
	const events: ReviewTraceEvent[] = [];
	const result = await review(
		bundle,
		{},
		(event: ReviewTraceEvent) => {
			events.push(event);
			Reflect.set(event, "passIndex", 99);
			if (
				event.surface === "candidate_finding" ||
				event.surface === "final_finding"
			) {
				Reflect.set(event.finding, "title", "observer-mutated");
				Reflect.set(event.finding, "severity", "P3");
			}
			throw new Error("observer stopped review");
		},
	);

	assert.deepEqual(
		{
			verdict: result.verdict,
			summary: result.summary,
			findings: result.findings,
			checked: result.checked,
			residualRisks: result.residualRisks,
			coverage: result.coverage,
		},
		{
			verdict: baseline.verdict,
			summary: baseline.summary,
			findings: baseline.findings,
			checked: baseline.checked,
			residualRisks: baseline.residualRisks,
			coverage: baseline.coverage,
		},
	);
	assert.equal(result.schemaVersion, baseline.schemaVersion);
	assert.equal(result.baseSha, baseline.baseSha);
	assert.equal(result.headSha, baseline.headSha);
	assert.deepEqual(
		result.stats?.map((stat) => ({ ...stat, durationMs: 0 })),
		baseline.stats?.map((stat) => ({ ...stat, durationMs: 0 })),
	);
	assert.equal(typeof result.totalDurationMs, "number");
	assert.equal(typeof baseline.totalDurationMs, "number");
	assert.equal(result.findings[0]?.severity, "P2");
	assert.deepEqual(result.residualRisks, []);
	const finalFindingEvent = events.find(
		(event) => event.surface === "final_finding",
	);
	assert.ok(finalFindingEvent?.finding);
	assert.notStrictEqual(finalFindingEvent?.finding, result.findings[0]);
	for (const event of events) {
		assert.equal(Object.isFrozen(event), true);
		if (
			event.surface === "candidate_finding" ||
			event.surface === "final_finding"
		) {
			assert.equal(Object.isFrozen(event.finding), true);
			assert.deepEqual(Object.keys(event.finding), [
				"category",
				"file",
				"lineStart",
				"title",
				"whyItBreaks",
			]);
		}
	}
	assert.equal(
		readFileSync(calls, "utf8").trim().split("\n").length,
		4,
		"observer delivery errors must not add review or critic calls",
	);
	assert.equal(
		result.traceDeliveryFailed,
		true,
		"observer throws must mark delivery health failed",
	);
});

test("rejected review carries traceDeliveryFailed when the observer threw", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			// Always emit unparseable output so the review rejects after the
			// successful-raw observer fires (and throws).
			"  fs.writeFileSync(out, 'not-json CANARY-DELIVERY-REJECT');",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const bundle: Bundle = {
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

	const rejection = await review(
		bundle,
		{},
		() => {
			throw new Error("observer boom");
		},
	).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "malformed runner output must reject");
	assert.equal(
		(rejection as Error & { traceDeliveryFailed?: boolean })
			.traceDeliveryFailed,
		true,
		"rejected reviews must ride delivery-health for eval score",
	);
});

test("review traces one parse-failed raw event for an empty successful runner attempt", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-test-"));
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
	writeFileSync(
		bin,
		[
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
			"    fs.writeFileSync(out, JSON.stringify({ summary: 'critic clean', findings: [], checked: ['critic checked'], residual_risks: [] }));",
			"    return;",
			"  }",
			"  const reviewCalls = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\\n').filter((line) => line.startsWith('review')).length : 0;",
			"  if (reviewCalls === 0) {",
			"    fs.appendFileSync(calls, 'review-empty\\n');",
			"    fs.writeFileSync(out, '');",
			"    return;",
			"  }",
			"  fs.appendFileSync(calls, 'review-valid\\n');",
			"  fs.writeFileSync(out, JSON.stringify({ summary: 'review clean', findings: [], checked: ['review checked'], residual_risks: [] }));",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";

	const events: ReviewTraceEvent[] = [];
	const result = await review(
		{
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
		},
		{},
		(event) => events.push(event),
	);

	assert.equal(result.verdict, "pass");
	assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [
		"review-empty",
		"review-valid",
		"critic",
	]);
	assert.deepEqual(
		events.filter(
			(event) =>
				event.surface === "raw_success" &&
				event.passKind === "review" &&
				event.promptAttempt === 1,
		),
		[
			{
				content: "",
				surface: "raw_success",
				passKind: "review",
				passIndex: 0,
				promptAttempt: 1,
				runnerAttempt: 1,
				outcome: "parse_failed",
			},
		],
	);
	assert.ok(result.rawOutputs, "nonempty successful raws remain retained");
	assert.equal(
		result.rawOutputs.includes(""),
		false,
		"the empty successful raw is transient trace data only",
	);
	assert.deepEqual(
		result.failedRawOutputs ?? [],
		[],
		"an empty parse failure must not be retained as a failed raw",
	);
	assert.equal(
		result.failedRawOutputs?.includes("") ?? false,
		false,
		"failed raw outputs must never contain an empty string",
	);
});
