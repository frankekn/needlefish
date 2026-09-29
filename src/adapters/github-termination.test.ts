import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { commitAll, headSha, initRepo } from "../shared/codex-runner-test-fixtures";

// A job timeout or watchdog terminates the needlefish process while its own
// in_progress check-run exists. Consumer repos call the binary from their own
// workflows, so nothing else completes that check: the binary must, within
// the termination grace, and must exit even when gh itself hangs.

const PR = 7;
const REPO = "acme/widgets";
const CHECK_ID = 7;

type GhCall = { readonly args: readonly string[]; readonly payload: string };

type Fixture = {
	readonly repo: string;
	readonly ghLog: string;
	readonly runnerPidFile: string;
	readonly env: NodeJS.ProcessEnv;
};

type FixtureOptions = {
	// The runner ignores SIGTERM (a hung provider stream); default exits on it.
	readonly runnerIgnoresTerm?: boolean;
	// The check-run PATCH never returns and ignores SIGTERM.
	readonly hangCheckPatch?: boolean;
	// Report a newer head from the second pull fetch onward.
	readonly staleHeadAfterStart?: boolean;
	readonly graceMs: number;
};

function isGhCall(raw: unknown): raw is GhCall {
	if (typeof raw !== "object" || raw === null) return false;
	const args = Reflect.get(raw, "args");
	const payload = Reflect.get(raw, "payload");
	return Array.isArray(args) && args.every((a) => typeof a === "string") && typeof payload === "string";
}

function readGhLog(file: string): readonly GhCall[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const raw: unknown = JSON.parse(line);
			if (!isGhCall(raw)) throw new Error("expected gh log entry");
			return raw;
		});
}

function checkPatches(calls: readonly GhCall[]): readonly GhCall[] {
	return calls.filter(
		(c) => c.args.includes("PATCH") && c.args.includes(`repos/${REPO}/check-runs/${CHECK_ID}`),
	);
}

type CheckCompletion = {
	readonly status: string;
	readonly conclusion: string;
	readonly output: { readonly title: string; readonly summary: string };
};

function completion(patch: GhCall): CheckCompletion {
	return JSON.parse(patch.payload) as CheckCompletion;
}

function postsToTimeline(calls: readonly GhCall[]): boolean {
	return calls.some(
		(c) => c.args.includes("POST") && c.args.some((a) => a.includes("/reviews") || a.includes("/comments")),
	);
}

function setupFixture(t: TestContext, opts: FixtureOptions): Fixture {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-terminate-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const repo = initRepo(tmp);
	const baseSha = headSha(repo);
	writeFileSync(path.join(repo, "src.ts"), "export const answer = 42;\n");
	commitAll(repo, "feature");
	const targetHead = headSha(repo);
	const laterHead = "f".repeat(40);

	const fakeBin = path.join(tmp, "bin");
	mkdirSync(fakeBin);
	const ghLog = path.join(tmp, "gh.log");
	const pullCount = path.join(tmp, "pull-count");
	const gh = path.join(fakeBin, "gh");
	writeFileSync(
		gh,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const args = process.argv.slice(2);",
			"const payload = args.includes('--input') ? fs.readFileSync(0, 'utf8') : '';",
			`fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ args, payload }) + '\\n');`,
			"const methodIdx = args.indexOf('-X');",
			"const method = methodIdx >= 0 ? args[methodIdx + 1] : 'GET';",
			"const apiPath = methodIdx >= 0 ? args[methodIdx + 2] : args[1];",
			`if (apiPath === ${JSON.stringify(`repos/${REPO}/pulls/${PR}`)}) {`,
			`  const count = fs.existsSync(${JSON.stringify(pullCount)}) ? Number(fs.readFileSync(${JSON.stringify(pullCount)}, 'utf8')) : 0;`,
			`  fs.writeFileSync(${JSON.stringify(pullCount)}, String(count + 1));`,
			`  const head = count > 0 && ${JSON.stringify(opts.staleHeadAfterStart === true)} ? ${JSON.stringify(laterHead)} : ${JSON.stringify(targetHead)};`,
			"  process.stdout.write(JSON.stringify({ state: 'open', title: 'PR', body: '', author_association: 'OWNER', user: { login: 'dev', type: 'User' }, comments_url: '', review_comments_url: '',",
			`    head: { sha: head }, base: { sha: ${JSON.stringify(baseSha)} } }));`,
			"  process.exit(0);",
			"}",
			"if (args[1] === '--paginate') { process.stdout.write('[[]]'); process.exit(0); }",
			"if (args[1] === 'user') { process.stdout.write(JSON.stringify({ login: 'dev', type: 'User' })); process.exit(0); }",
			`if (apiPath === ${JSON.stringify(`repos/${REPO}/check-runs`)} && method === 'POST') { process.stdout.write(JSON.stringify({ id: ${CHECK_ID} })); process.exit(0); }`,
			`if (method === 'PATCH' && ${JSON.stringify(opts.hangCheckPatch === true)}) { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); }`,
			"else { process.stdout.write('{}'); process.exit(0); }",
		].join("\n"),
	);
	chmodSync(gh, 0o755);

	const runnerPidFile = path.join(tmp, "runner.pid");
	const runner = path.join(tmp, "claude.cjs");
	writeFileSync(
		runner,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"process.stdin.resume();",
			`if (${JSON.stringify(opts.runnerIgnoresTerm === true)}) process.on('SIGTERM', () => {});`,
			`fs.writeFileSync(${JSON.stringify(runnerPidFile)}, String(process.pid));`,
			"setInterval(() => {}, 1000);",
		].join("\n"),
	);
	chmodSync(runner, 0o755);

	const env: NodeJS.ProcessEnv = {
		...process.env,
		PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
		GITHUB_REPOSITORY: REPO,
		PR_BASE_SHA: baseSha,
		PR_HEAD_SHA: targetHead,
		NEEDLEFISH_RUNNER: "claude",
		CLAUDE_BIN: runner,
		NEEDLEFISH_NO_FAST_PATH: "1",
		NEEDLEFISH_NO_RETRY: "1",
		NEEDLEFISH_TMPDIR: path.join(tmp, "nftmp"),
		NEEDLEFISH_TERMINATION_GRACE_MS: String(opts.graceMs),
	};
	delete env.NEEDLEFISH_ALLOW_UNTRUSTED_AUTHOR;
	return { repo, ghLog, runnerPidFile, env };
}

function isMissingProcess(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function killIfRunning(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch (error) {
		if (!isMissingProcess(error)) throw error;
	}
}

async function waitForFile(file: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	while (!existsSync(file)) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
		await delay(20);
	}
}

function waitForExit(child: ChildProcess): Promise<[number | null, NodeJS.Signals | null]> {
	return new Promise((resolve) => child.once("exit", (status, signal) => resolve([status, signal])));
}

async function terminateMidReview(
	t: TestContext,
	fixture: Fixture,
): Promise<{ status: number | null; signal: NodeJS.Signals | null; elapsedMs: number; stderr: string }> {
	const child = spawn(
		process.execPath,
		["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), "--github", "--pr", String(PR), "--repo", fixture.repo],
		{ env: fixture.env, stdio: ["ignore", "pipe", "pipe"] },
	);
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => (stderr += chunk));
	child.stdout?.resume();
	t.after(() => {
		if (child.pid !== undefined) killIfRunning(child.pid);
		if (existsSync(fixture.runnerPidFile)) killIfRunning(-Number(readFileSync(fixture.runnerPidFile, "utf8")));
	});
	await waitForFile(fixture.runnerPidFile);
	const started = Date.now();
	child.kill("SIGTERM");
	const [status, signal] = await waitForExit(child);
	return { status, signal, elapsedMs: Date.now() - started, stderr };
}

test("SIGTERM completes the owned check as a terminated failure and exits within the grace", { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
	const fixture = setupFixture(t, { runnerIgnoresTerm: true, graceMs: 1500 });
	const run = await terminateMidReview(t, fixture);

	assert.equal(run.signal, null, run.stderr);
	assert.equal(run.status, 143, run.stderr);
	assert.ok(run.elapsedMs < 4000, `termination took ${run.elapsedMs}ms`);
	const calls = readGhLog(fixture.ghLog);
	const patches = checkPatches(calls);
	assert.equal(patches.length, 1, JSON.stringify(calls.map((c) => c.args)));
	const body = completion(patches[0]);
	assert.equal(body.status, "completed");
	assert.equal(body.conclusion, "failure");
	assert.equal(body.output.title, "Needlefish: review terminated");
	assert.match(body.output.summary, /SIGTERM/);
	assert.match(body.output.summary, /not a code verdict/);
	assert.equal(postsToTimeline(calls), false, "termination must not post review or timeline comments");
});

test("a runner that exits on SIGTERM still yields exactly one terminated completion", { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
	const fixture = setupFixture(t, { graceMs: 1500 });
	const run = await terminateMidReview(t, fixture);

	assert.equal(run.status, 143, run.stderr);
	const calls = readGhLog(fixture.ghLog);
	const patches = checkPatches(calls);
	assert.equal(patches.length, 1, JSON.stringify(calls.map((c) => c.args)));
	assert.equal(completion(patches[0]).output.title, "Needlefish: review terminated");
	assert.equal(postsToTimeline(calls), false, "the review-failed error comment must not be posted for a termination");
});

test("termination finishes within the grace when gh hangs on the check PATCH", { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
	const fixture = setupFixture(t, { runnerIgnoresTerm: true, hangCheckPatch: true, graceMs: 1000 });
	const run = await terminateMidReview(t, fixture);

	assert.equal(run.signal, null, run.stderr);
	assert.equal(run.status, 143, run.stderr);
	assert.ok(run.elapsedMs < 4000, `termination took ${run.elapsedMs}ms`);
	assert.equal(checkPatches(readGhLog(fixture.ghLog)).length, 1, "the PATCH must be attempted before giving up");
});

test("termination on a stale head completes the check as superseded", { timeout: 30_000, skip: process.platform === "win32" }, async (t) => {
	const fixture = setupFixture(t, { runnerIgnoresTerm: true, staleHeadAfterStart: true, graceMs: 1500 });
	const run = await terminateMidReview(t, fixture);

	assert.equal(run.status, 143, run.stderr);
	const calls = readGhLog(fixture.ghLog);
	const patches = checkPatches(calls);
	assert.equal(patches.length, 1);
	const body = completion(patches[0]);
	assert.equal(body.conclusion, "neutral");
	assert.equal(body.output.title, "Needlefish: superseded");
	assert.equal(postsToTimeline(calls), false);
});
