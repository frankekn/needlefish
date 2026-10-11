import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { review, type ReviewProgressEvent } from "./review";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle } from "../shared/schema";

const FINDING =
	"{ severity: 'P2', title: 'Bug', category: 'bug', file: 'src/a.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'test' }";

// Map covers src/a.ts only, so src/b.ts lands in the tail-coverage hotspot.
// The tail deep pass emits unusable output, so one deep pass fails.
const STUB = [
	"#!/usr/bin/env node",
	"const fs = require('node:fs');",
	"let input = '';",
	"process.stdin.setEncoding('utf8');",
	"process.stdin.on('data', (c) => { input += c; });",
	"process.stdin.on('end', () => {",
	"  const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
	`  const finding = ${FINDING};`,
	"  let body;",
	"  if (input.includes('review-MAP pass')) body = { summary: 'mapped', hotspots: [{ name: 'a', files: ['src/a.ts'], why: 'w', risk: 'high', edges: [] }] };",
	"  else if (input.includes('doing a DEEP review') && input.includes('tail-coverage')) body = 'not json';",
	"  else if (input.includes('doing a DEEP review')) body = { summary: 'deep', findings: [finding, finding], checked: ['c'], residual_risks: [] };",
	"  else body = { summary: 'ok', findings: [finding], checked: ['c'], residual_risks: [] };",
	"  fs.writeFileSync(out, typeof body === 'string' ? body : JSON.stringify(body));",
	"});",
].join("\n");

function setup(t: TestContext, deep: boolean): Bundle {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-progress-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const keys = [
		"CODEX_BIN",
		"CODEX_RETRY_MS",
		"NEEDLEFISH_DEEP_CONCURRENCY",
		"NEEDLEFISH_RUNNER",
	] as const;
	const previous = keys.map((key) => [key, process.env[key]] as const);
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(bin, STUB);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	// Serial deep passes make the running failed count deterministic.
	process.env.NEEDLEFISH_DEEP_CONCURRENCY = "1";
	delete process.env.NEEDLEFISH_RUNNER;
	return {
		repoPath: repo,
		baseSha: "base",
		headSha: headSha(repo),
		patch: "short",
		patchStat: " src/a.ts | 1 +\n src/b.ts | 1 +",
		changedFiles: [
			{ path: "src/a.ts", surface: "source" },
			{ path: "src/b.ts", surface: "source" },
		],
		agentsMd: "(none)",
		prMeta: null,
		deep,
		focus: null,
	};
}

function stages(events: readonly ReviewProgressEvent[]): unknown[] {
	return events.map((event) =>
		event.stage === "done" ? { stage: "done" } : event,
	);
}

function withoutTiming(result: Awaited<ReturnType<typeof review>>): unknown {
	return {
		...result,
		stats: result.stats?.map((stat) => ({ ...stat, durationMs: 0 })),
		totalDurationMs: 0,
	};
}

test("small path reports review, critic, done", async (t) => {
	const bundle = setup(t, false);
	const events: ReviewProgressEvent[] = [];
	const observed = await review(bundle, {}, undefined, (e) => events.push(e));
	assert.deepEqual(stages(events), [
		{ stage: "review", files: 2 },
		{ stage: "critic", findings: 1 },
		{ stage: "done" },
	]);
	const done = events.at(-1);
	assert.ok(done?.stage === "done" && done.durationMs >= 0);
	assert.deepEqual(withoutTiming(observed), withoutTiming(await review(bundle)));
});

test("large path reports map, deep n/total with tail and failures, dedup, critic, done", async (t) => {
	const bundle = setup(t, true);
	const events: ReviewProgressEvent[] = [];
	const observed = await review(bundle, {}, undefined, (e) => events.push(e));
	assert.deepEqual(stages(events), [
		{ stage: "map", files: 2 },
		{ stage: "deep", done: 0, failed: 0, total: 2, tail: true },
		{ stage: "deep", done: 1, failed: 0, total: 2, tail: true },
		{ stage: "deep", done: 2, failed: 1, total: 2, tail: true },
		{ stage: "dedup", before: 2, after: 1 },
		{ stage: "critic", findings: 1 },
		{ stage: "done" },
	]);
	assert.deepEqual(withoutTiming(observed), withoutTiming(await review(bundle)));
});

test("docs-only fast path reports nothing", async (t) => {
	const bundle = setup(t, false);
	const events: ReviewProgressEvent[] = [];
	await review(
		{ ...bundle, changedFiles: [{ path: "README.md", surface: "docs" }] },
		{},
		undefined,
		(e) => events.push(e),
	);
	assert.deepEqual(events, []);
});
