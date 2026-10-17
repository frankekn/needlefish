import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pairedSchedule, assertDirectoryInventory, study } from "./deep-concurrency";
import { loadFixture } from "../shared/fixture";
import fixture from "../fixtures/large-clean-sweep/spec";
import { review } from "../../src/core/review";

test("schedule balances fixed fixture pairs and order across six replicates", () => {
	const schedule = pairedSchedule();
	assert.equal(schedule.length, 24);
	assert.deepEqual(schedule.slice(0, 4).map((slot) => [slot.fixtureId, slot.deepConcurrency]), [
		["large-tail-boundary-bug", 3], ["large-tail-boundary-bug", 7],
		["large-clean-sweep", 7], ["large-clean-sweep", 3],
	]);
	for (const fixtureId of ["large-tail-boundary-bug", "large-clean-sweep"]) {
		const slots = schedule.filter((slot) => slot.fixtureId === fixtureId);
		assert.deepEqual([3, 7].map((arm) => slots.filter((slot) => slot.deepConcurrency === arm).length), [6, 6]);
		assert.equal(slots.filter((slot) => slot.position === 1 && slot.deepConcurrency === 3).length, 3);
		for (let i = 0; i < slots.length; i += 2) {
			assert.equal(slots[i].replicate, slots[i + 1].replicate);
			assert.equal(slots[i].deepConcurrency + slots[i + 1].deepConcurrency, 10);
		}
	}
});

test("source inventory rejects added files and symlinks, including untracked paths", (t) => {
	const tmp = mkdtempSync(path.join(tmpdir(), "needlefish-inventory-proof-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	for (const dir of ["src", "prompts", "eval/shared"]) mkdirSync(path.join(tmp, dir), { recursive: true });
	writeFileSync(path.join(tmp, "src/a.ts"), "fixed");
	const expected = ["src/a.ts", "tsconfig.json", "tsconfig.build.json"];
	for (const file of expected.slice(1)) writeFileSync(path.join(tmp, file), "{}");
	assertDirectoryInventory(tmp, expected);
	writeFileSync(path.join(tmp, "src/extra.ts"), "not pinned");
	assert.throws(() => assertDirectoryInventory(tmp, expected), /source path drift/);
	rmSync(path.join(tmp, "src/extra.ts"));
	symlinkSync(path.join(tmp, "src/a.ts"), path.join(tmp, "src/link.ts"));
	assert.throws(() => assertDirectoryInventory(tmp, expected), /source symlink/);
	rmSync(path.join(tmp, "src/link.ts"));
	writeFileSync(path.join(tmp, "tsconfig.future.json"), "{}");
	assert.throws(() => assertDirectoryInventory(tmp, expected), /source path drift/);
	rmSync(path.join(tmp, "tsconfig.future.json"));
	rmSync(path.join(tmp, "tsconfig.build.json"));
	assert.throws(() => assertDirectoryInventory(tmp, expected), /source path drift/);
	symlinkSync(path.join(tmp, "tsconfig.json"), path.join(tmp, "tsconfig.build.json"));
	assert.throws(() => assertDirectoryInventory(tmp, expected), /source symlink/);
	rmSync(path.join(tmp, "tsconfig.build.json"));
	mkdirSync(path.join(tmp, "tsconfig.build.json"));
	assert.throws(() => assertDirectoryInventory(tmp, expected), /source not a regular file/);
});

test("study CLI rejects execution flags before loading a fixture", () => {
	const child = spawnSync(process.execPath, ["--import", "tsx", "eval/tools/deep-concurrency.ts", "--run"], {
		encoding: "utf8",
	});
	assert.equal(child.status, 1);
	assert.match(child.stderr, /only --plan is supported; model execution is disabled/);
	assert.equal(child.stdout, "");
});

test("v1 keeps its original comparator, protocol, and archived generator bytes", () => {
	const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
	assert.equal(digest("eval/campaigns/deep-concurrency-v1.plan.json"),
		"c7f872f3293ebd7c94b8f9d51dc93ac30aac93b1d8f15e5544769d714f01a5fb");
	assert.equal(digest("eval/campaigns/deep-concurrency-v1.md"),
		"bf9db1343122abdd7e5e0956a5779bdbfc81ac610645e0820d45fc6f2f1e1d51");
	assert.equal(digest("eval/campaigns/deep-concurrency-v1.generator.ts.txt"),
		"b9e140fb8814b1d724b2e53b147a56ea519d5c8af7a978339955a13c9e854c19");
});

test("current v2 plan freezes its complete study, schedule, and protocol identity", () => {
	const plan: unknown = JSON.parse(readFileSync("eval/campaigns/deep-concurrency-v2.plan.json", "utf8"));
	assert.ok(plan && typeof plan === "object" && "protocolFiles" in plan && "schedule" in plan
		&& "modelCallsEnabled" in plan && "selection" in plan);
	assert.deepEqual(Object.fromEntries(Object.entries(plan).filter(([key]) => key in study)), study);
	assert.equal(study.id, "issue193-deep-concurrency-v2");
	assert.equal(study.source, "195db3e20baddf58c4206a98d12ae29f92084e3d");
	assert.equal(plan.modelCallsEnabled, false);
	assert.deepEqual(plan.schedule, pairedSchedule());
	assert.ok(Array.isArray(plan.selection));
	assert.deepEqual(plan.selection.map((entry: unknown) => {
		assert.ok(entry && typeof entry === "object" && "id" in entry && "changedFiles" in entry);
		return { id: entry.id, changedFiles: entry.changedFiles };
	}), [{ id: "large-tail-boundary-bug", changedFiles: 27 }, { id: "large-clean-sweep", changedFiles: 27 }]);
	assert.deepEqual(plan.protocolFiles, ["eval/tools/deep-concurrency.ts", "eval/campaigns/deep-concurrency-v2.md", "eval/campaigns/deep-concurrency-v1.md"]
		.map((file) => ({ file, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") })));
});

test("current CLI admits its pinned v2 plan and rejects version, protocol, config, and source drift", (t) => {
	const tmp = mkdtempSync(path.join(tmpdir(), "needlefish-plan-version-proof-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	execFileSync("git", ["clone", "--shared", "--no-checkout", "--quiet", process.cwd(), tmp]);
	execFileSync("git", ["checkout", "--quiet", "--detach", study.source], { cwd: tmp });
	for (const file of ["eval/tools/deep-concurrency.ts", "eval/campaigns/deep-concurrency-v2.md",
		"eval/campaigns/deep-concurrency-v2.plan.json", "eval/campaigns/deep-concurrency-v1.md"]) {
		copyFileSync(file, path.join(tmp, file));
	}
	symlinkSync(path.resolve("node_modules"), path.join(tmp, "node_modules"), "dir");
	const run = () => spawnSync(process.execPath, ["--import", "tsx", "eval/tools/deep-concurrency.ts", "--plan"], {
		cwd: tmp, encoding: "utf8", timeout: 60000,
	});
	const expected = readFileSync("eval/campaigns/deep-concurrency-v2.plan.json", "utf8");
	for (let replay = 0; replay < 2; replay++) {
		const result = run();
		assert.equal(result.status, 0, result.stderr);
		assert.ok(result.stdout === expected, "v2 output must match every committed comparator byte");
		assert.notEqual(result.stdout, readFileSync("eval/campaigns/deep-concurrency-v1.plan.json", "utf8"));
	}
	for (const [file, replacement, error] of [
		["eval/tools/deep-concurrency.ts", (value: string) => value.replace("issue193-deep-concurrency-v2", "issue193-deep-concurrency-v1"), /study plan drift/],
		["eval/campaigns/deep-concurrency-v2.md", (value: string) => value + "\n", /study plan drift/],
		["eval/campaigns/deep-concurrency-v1.md", (value: string) => value + "\n", /study plan drift/],
		["tsconfig.json", (value: string) => value + "\n", /source drift: tsconfig.json/],
		["src/core/review.ts", (value: string) => value + "\n", /source drift: src\/core\/review.ts/],
	] satisfies [string, (value: string) => string, RegExp][]) {
		const target = path.join(tmp, file);
		const original = readFileSync(target, "utf8");
		writeFileSync(target, replacement(original));
		try {
			const result = run();
			assert.equal(result.status, 1, file);
			assert.equal(result.stdout, "", file);
			assert.match(result.stderr, error);
		} finally { writeFileSync(target, original); }
	}
});

test("production deep scheduler drains seven fake jobs at limits three and seven", async (t) => {
	const tmp = mkdtempSync(path.join(tmpdir(), "needlefish-concurrency-proof-"));
	const loaded = loadFixture(fixture);
	const previous = { ...process.env };
	t.after(() => {
		for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
		Object.assign(process.env, previous);
		loaded.cleanup();
		rmSync(tmp, { recursive: true, force: true });
	});
	const bin = path.join(tmp, "fake-codex.cjs");
	const files = loaded.bundle.changedFiles.slice(0, 6).map((file) => file.path);
	const barrier = path.join(tmp, "events.jsonl");
	writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 const out = process.argv[process.argv.indexOf('--output-last-message') + 1];
 const log = event => fs.appendFileSync(${JSON.stringify(barrier)}, JSON.stringify(event) + '\\n');
 const answer = value => fs.writeFileSync(out, JSON.stringify(value));
 if (input.includes('review-MAP pass')) {
  log({kind: 'map'});
  answer({summary:'mapped', hotspots:${JSON.stringify(files)}.map((file, i) => ({name:'h'+i, files:[file], why:'changed', risk:'high', edges:[]}))});
 } else if (input.includes('doing a DEEP review')) {
  const name = /"name": "([^"\\n]+)"/.exec(input)[1];
  log({kind:'start', name});
  const expected = Number(fs.readFileSync(${JSON.stringify(path.join(tmp, "limit"))}, 'utf8'));
  const releaseDeadline = Number(fs.readFileSync(${JSON.stringify(path.join(tmp, "release-deadline"))}, 'utf8'));
  const release = () => {
   const starts = fs.readFileSync(${JSON.stringify(barrier)}, 'utf8').trim().split('\\n').map(JSON.parse).filter(e => e.kind === 'start').length;
   if (starts < expected && Date.now() < releaseDeadline) { setTimeout(release, 10); return; }
   log({kind:'end', name});
   answer({summary:'checked', findings:[], checked:['checked '+name], residual_risks:[]});
  };
  release();
 } else if (input.includes('adversarial critic')) {
  log({kind:'critic'});
  answer({summary:'checked', findings:[], checked:['all changed files'], residual_risks:[]});
 } else { process.stderr.write('unexpected prompt'); process.exit(1); }
});
`);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_TIMEOUT_MS = "30000";
	process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "60000";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	delete process.env.CODEX_PROXY_BASE_URL;
	delete process.env.CODEX_PROXY_API_KEY;
	delete process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED;
	for (const arm of [3, 7]) {
		writeFileSync(barrier, "");
		writeFileSync(path.join(tmp, "limit"), String(arm));
		writeFileSync(path.join(tmp, "release-deadline"), String(Date.now() + 5000));
		process.env.NEEDLEFISH_DEEP_CONCURRENCY = String(arm);
		const result = await review(loaded.bundle, { runner: "codex", model: "fake-offline" });
		const events: unknown[] = readFileSync(barrier, "utf8").trim().split("\n").map((line) => JSON.parse(line));
		let active = 0;
		let maximum = 0;
		let started = 0;
		let ended = 0;
		let maps = 0;
		let critics = 0;
		for (const event of events) {
			assert.ok(event && typeof event === "object" && "kind" in event);
			if (event.kind === "start") { active++; started++; maximum = Math.max(active, maximum); }
			if (event.kind === "end") { active--; ended++; }
			if (event.kind === "map") maps++;
			if (event.kind === "critic") { assert.equal(active, 0); critics++; }
		}
		assert.deepEqual({ started, ended, active, maximum, maps, critics },
			{ started: 7, ended: 7, active: 0, maximum: arm, maps: 1, critics: 1 });
		t.diagnostic(JSON.stringify({ evidence: "fake-scheduling-only", arm, started, ended, active, maximum, maps, critics }));
		assert.equal(result.verdict, "pass");
		assert.equal(result.stats?.reduce((sum, stat) => sum + stat.attempts, 0), 9);
	}
});
