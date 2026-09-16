import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { review, reviewPlan } from "../core/review.js";
import { RunnerOperationalError } from "../shared/codex.js";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures.js";
import type { Bundle } from "../shared/schema.js";
import { diffBundle } from "./local.js";

function object(raw: unknown): Record<string, unknown> {
	assert.ok(raw !== null && typeof raw === "object" && !Array.isArray(raw));
	return raw as Record<string, unknown>;
}

function records(file: string): Record<string, unknown>[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => object(JSON.parse(line)));
}

function fixture(t: TestContext, docs = false) {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-preflight-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const repo = initRepo(tmp);
	gitText(["branch", "-M", "main"], repo);
	const base = headSha(repo);
	gitText(["checkout", "-b", "feature"], repo);
	writeFileSync(path.join(repo, docs ? "README.md" : "app.ts"), docs ? "guide\n" : "export const value = 1;\n");
	commitAll(repo, "feature");
	const head = headSha(repo);
	const bin = path.join(tmp, "bin");
	const home = path.join(tmp, "home");
	mkdirSync(bin);
	mkdirSync(home);
	mkdirSync(path.join(tmp, "temp"));
	const runnerLog = path.join(tmp, "runner.jsonl");
	const posts = path.join(tmp, "posts.jsonl");
	const response = { summary: "checked", findings: [], checked: ["app.ts"], residual_risks: [] };
	const claude = path.join(bin, "claude");
	writeFileSync(claude, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
fs.appendFileSync(${JSON.stringify(runnerLog)}, JSON.stringify({prompt}) + '\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(response))});
`);
	chmodSync(claude, 0o755);
	const pr = { number: 7, state: "open", title: "fixture", body: "", head: { sha: head }, base: { sha: base }, baseRefOid: base, headRefOid: head, baseRefName: "main", headRefName: "feature", comments: [], reviews: [], statusCheckRollup: [] };
	const gh = path.join(bin, "gh");
	writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'pr' && args[1] === 'view') { console.log(JSON.stringify(${JSON.stringify(pr)})); process.exit(0); }
if (args[0] !== 'api') process.exit(2);
const verb = args.includes('-X') ? args[args.indexOf('-X') + 1] : 'GET';
const endpoint = args.find(a => a.startsWith('repos/')) || args[1];
if (verb !== 'GET') {
  const payload = args.includes('--input') ? JSON.parse(fs.readFileSync(0, 'utf8')) : {};
  fs.appendFileSync(${JSON.stringify(posts)}, JSON.stringify({verb, endpoint, payload}) + '\\n');
  console.log(JSON.stringify(endpoint.endsWith('/check-runs') ? {id: 42} : {}));
} else if (endpoint === 'user') console.log(JSON.stringify({login: 'fixture-user'}));
else if (endpoint.endsWith('/pulls/7')) console.log(JSON.stringify(${JSON.stringify(pr)}));
else if (endpoint.endsWith('/reviews') || endpoint.endsWith('/comments')) console.log('[]');
else if (endpoint.includes('/labels/')) console.log('{}');
else { console.error('unexpected gh args ' + args.join(' ')); process.exit(2); }
`);
	chmodSync(gh, 0o755);
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) {
		if (/^(NEEDLEFISH_|CODEX_|CLAUDE_|OPENAI_|PR_)/.test(key)) delete env[key];
	}
	Object.assign(env, {
		PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home,
		NEEDLEFISH_TMPDIR: path.join(tmp, "temp"), NEEDLEFISH_RUNNER: "openai",
		OPENAI_API_KEY: "fixture-not-a-real-key", OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
		CLAUDE_BIN: claude, NEEDLEFISH_ACP_BIN: claude,
		GITHUB_REPOSITORY: "frankekn/needlefish", PR_BASE_SHA: base, PR_HEAD_SHA: head,
	});
	const cli = (args: readonly string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(
		process.execPath,
		["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), ...args, "--repo", repo, "--model", "fixture"],
		{ cwd: process.cwd(), env: { ...env, ...overrides }, encoding: "utf8", timeout: 15000 },
	);
	return { repo, home, runnerLog, posts, cli };
}

for (const shape of ["small", "deep", "large_files", "large_patch"] as const) {
	test(`HTTP ${shape} is rejected before any HTTP request or model trace`, async (t) => {
		const f = fixture(t);
		const base = diffBundle(f.repo, { base: "main" }).bundle;
		const bundle: Bundle = {
			...base,
			deep: shape === "deep",
			...(shape === "large_files" ? { changedFiles: Array.from({ length: 11 }, (_, i) => ({ path: `app${i}.ts`, surface: "source" as const })) } : {}),
			...(shape === "large_patch" ? { patch: base.patch.repeat(1000) } : {}),
		};
		const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("HTTP must not be called"); });
		const plan = reviewPlan(bundle, { runner: "openai" });
		assert.equal(plan.largePath, shape !== "small");
		assert.equal(plan.runnerPreflight.status, "unsupported");
		if (plan.runnerPreflight.status !== "unsupported") throw new Error("expected unsupported");
		let traces = 0;
		await assert.rejects(review(bundle, { runner: "openai", model: "fixture" }, () => { traces++; }), {
			name: "RunnerOperationalError", message: plan.runnerPreflight.message,
		});
		assert.equal(fetch.mock.callCount(), 0);
		assert.equal(traces, 0);
	});
}

test("unknown ACP fails in core before launching an agent", async (t) => {
	const f = fixture(t);
	const bundle = diffBundle(f.repo, { base: "main" }).bundle;
	const previous = process.env.NEEDLEFISH_ACP_REPOSITORY_READ_SHA256;
	delete process.env.NEEDLEFISH_ACP_REPOSITORY_READ_SHA256;
	t.after(() => {
		if (previous === undefined) delete process.env.NEEDLEFISH_ACP_REPOSITORY_READ_SHA256;
		else process.env.NEEDLEFISH_ACP_REPOSITORY_READ_SHA256 = previous;
	});
	await assert.rejects(review(bundle, { runner: "acp" }), (error: unknown) => {
		assert.ok(error instanceof RunnerOperationalError);
		assert.match(error.message, /capability is unknown/);
		return true;
	});
	assert.deepEqual(records(f.runnerLog), []);
});

for (const mode of ["local", "pr"] as const) {
	for (const output of ["actual", "text", "json", "bundle"] as const) {
		test(`${mode} ${output} uses the same unsupported preflight without cache writes`, (t) => {
			const f = fixture(t);
			const plan = reviewPlan(diffBundle(f.repo, { base: "main" }).bundle, { runner: "openai" });
			assert.equal(plan.runnerPreflight.status, "unsupported");
			if (plan.runnerPreflight.status !== "unsupported") throw new Error("expected unsupported");
			const args: string[] = mode === "pr" ? ["pr", "7"] : [];
			if (output === "actual") args.push("--json");
			else {
				args.push("--dry-run");
				if (output === "json") args.push("--json");
				if (output === "bundle") args.push("--print-bundle");
			}
			const result = f.cli(args);
			assert.equal(result.status, 1, result.stderr);
			assert.equal(result.stderr.trim(), `needlefish: ${plan.runnerPreflight.message}`);
			if (output === "actual") assert.equal(result.stdout, "");
			if (output === "text") assert.match(result.stdout, /runnerPreflight: unsupported/);
			if (output === "json") {
				const json = object(JSON.parse(result.stdout));
				assert.deepEqual(json.runnerPreflight, plan.runnerPreflight);
				assert.equal(json.verdict, undefined);
				assert.equal(json.patch, undefined);
			}
			if (output === "bundle") {
				const json = object(JSON.parse(result.stdout));
				assert.equal(json.runnerPreflight, undefined);
				assert.equal(typeof json.patch, "string");
			}
			assert.deepEqual(records(f.runnerLog), []);
			assert.equal(existsSync(path.join(f.home, ".cache", "needlefish")), false);
		});
	}
}

for (const runner of ["openai", "acp"] as const) {
	test(`GitHub ${runner} completes its pending check as failure, not a passing review`, (t) => {
		const f = fixture(t);
		const result = f.cli(["github", "--pr", "7", "--runner", runner]);
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /Unsupported runner capability/);
		const posts = records(f.posts);
		const checks = posts.filter((p) => String(p.endpoint).includes("/check-runs"));
		assert.equal(checks.length, 2);
		assert.equal(object(checks[0].payload).status, "in_progress");
		assert.equal(checks[1].verb, "PATCH");
		assert.equal(object(checks[1].payload).conclusion, "failure");
		assert.match(String(object(object(checks[1].payload).output).summary), /No model calls were made/);
		assert.equal(posts.some((p) => String(p.endpoint).endsWith("/reviews")), false);
		assert.deepEqual(records(f.runnerLog), []);
	});
}

for (const mode of ["local", "pr", "github"] as const) {
	test(`${mode} docs-only policy skip still needs no repository-capable runner`, (t) => {
		const f = fixture(t, true);
		const args = mode === "local" ? ["--json"] : mode === "pr" ? ["pr", "7", "--json"] : ["github", "--pr", "7"];
		const result = f.cli(args);
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /model review skipped/);
		assert.deepEqual(records(f.runnerLog), []);
		if (mode !== "github") assert.equal(object(JSON.parse(result.stdout)).verdict, "pass");
	});
}

test("supported CLI preview does not launch the runner and exposes adapter capability", (t) => {
	const f = fixture(t);
	const result = f.cli(["--dry-run", "--json", "--runner", "claude"]);
	assert.equal(result.status, 0, result.stderr);
	const preflight = object(object(JSON.parse(result.stdout)).runnerPreflight);
	assert.equal(preflight.status, "ready");
	assert.equal(preflight.capabilitySource, "adapter");
	assert.deepEqual(records(f.runnerLog), []);
});

test("supported CLI still runs review plus critic without preflight metadata in prompts or results", (t) => {
	const f = fixture(t);
	const result = f.cli(["--json", "--runner", "claude"]);
	assert.equal(result.status, 0, result.stderr);
	const json = object(JSON.parse(result.stdout));
	assert.equal(json.verdict, "pass");
	assert.equal(json.runnerPreflight, undefined);
	assert.deepEqual(json.findings, []);
	const calls = records(f.runnerLog);
	assert.equal(calls.length, 2);
	for (const call of calls) assert.doesNotMatch(String(call.prompt), /runnerPreflight|capabilitySource|operator_declared/);
});
