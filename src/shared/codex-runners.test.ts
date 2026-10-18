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
import {
	exitFailureNextStep,
	extractJson,
	runCodex,
	RunnerOperationalError,
	safeOutputCause,
	safeRunnerCause,
	timeoutMsFor,
} from "./codex";
import {
	commitAll,
	gitText,
	headSha,
	initRepo,
	readStringArray,
} from "./codex-runner-test-fixtures";
import { RUNNERS } from "./runner";

test("runCodex classifies invalid timeout configuration as operational", async (t) => {
	const previous = {
		timeout: process.env.NEEDLEFISH_TIMEOUT_MS,
		noRetry: process.env.NEEDLEFISH_NO_RETRY,
	};
	t.after(() => {
		if (previous.timeout === undefined) delete process.env.NEEDLEFISH_TIMEOUT_MS;
		else process.env.NEEDLEFISH_TIMEOUT_MS = previous.timeout;
		if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
	});
	process.env.NEEDLEFISH_TIMEOUT_MS = "invalid";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	await assert.rejects(
		() => runCodex("prompt", { runner: "codex", repoPath: process.cwd(), targetHeadSha: "HEAD" }),
		RunnerOperationalError,
	);
});

test("runCodex classifies a runner that exits before reading stdin by its exit status, not EPIPE", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "claude-exit-1.sh");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		noRetry: process.env.NEEDLEFISH_NO_RETRY,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(bin, ["#!/bin/sh", "echo 'auth error code: expired_token' >&2", "exit 1"].join("\n"));
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_NO_RETRY = "1";

	// Larger than any pipe buffer, so the write fails with EPIPE once the child exits.
	const prompt = "x".repeat(10_000_000);
	await assert.rejects(
		() => runCodex(prompt, { runner: "claude", repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 5000 }),
		(error: unknown) => {
			assert.ok(error instanceof RunnerOperationalError);
			assert.equal(
				error.message,
				"claude runner exited 1; likely cause: auth error (expired_token); stderr withheld because it may contain the review prompt. Run `claude auth login`, then retry.",
			);
			return true;
		},
	);
});

test("runCodex invokes claude without permission restrictions", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const targetHeadSha = headSha(repo);
	writeFileSync(path.join(repo, "README.md"), "wrong checkout\n");
	commitAll(repo, "advance source checkout");
	const bin = path.join(tmp, "claude-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const inputPath = path.join(tmp, "stdin.txt");
	const readmePath = path.join(tmp, "readme.txt");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		codexTimeout: process.env.CODEX_TIMEOUT_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.codexTimeout === undefined)
			delete process.env.CODEX_TIMEOUT_MS;
		else process.env.CODEX_TIMEOUT_MS = previous.codexTimeout;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
			`fs.writeFileSync(${JSON.stringify(inputPath)}, fs.readFileSync(0, 'utf8'));`,
			`fs.writeFileSync(${JSON.stringify(readmePath)}, fs.readFileSync('README.md', 'utf8'));`,
			"process.stdout.write('{\"ok\":true}');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "claude";
	process.env.CODEX_TIMEOUT_MS = "0";

	const output = await runCodex("prompt", { repoPath: repo, targetHeadSha });
	const args = readStringArray(argsPath);

	assert.equal(output, '{"ok":true}');
	assert.deepEqual(args.slice(0, 6), [
		"--print",
		"--output-format",
		"text",
		"--dangerously-skip-permissions",
		"--safe-mode",
		"--no-session-persistence",
	]);
	assert.equal(args.includes("prompt"), false);
	assert.equal(readFileSync(inputPath, "utf8"), "prompt");
	assert.equal(readFileSync(readmePath, "utf8"), "fixture\n");
});





for (const runner of ["claude", "grok"] as const) {
	test(`runCodex rejects ${runner} when it dirties the target repo`, async (t) => {
		const binEnv = runner === "claude" ? "CLAUDE_BIN" : "GROK_BIN";
		const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
		const repo = initRepo(tmp);
		const bin = path.join(tmp, "claude-bin.js");
		const previous = {
			bin: process.env[binEnv],
			runner: process.env.NEEDLEFISH_RUNNER,
		};
		t.after(() => {
			if (previous.bin === undefined) delete process.env[binEnv];
			else process.env[binEnv] = previous.bin;
			if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
			else process.env.NEEDLEFISH_RUNNER = previous.runner;
			rmSync(tmp, { recursive: true, force: true });
		});
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"const fs = require('node:fs');",
				...(runner === "grok" ? [
					"const prompt = fs.readFileSync(process.argv[process.argv.indexOf('--prompt-file') + 1], 'utf8');",
					"const repoPath = JSON.parse(prompt.slice('The repository to inspect is '.length, prompt.indexOf('. Your startup directory')));",
					"fs.writeFileSync(require('node:path').join(repoPath, 'runner-wrote.txt'), 'dirty');",
				] : ["fs.writeFileSync('runner-wrote.txt', 'dirty');"]),
				"process.stdout.write('{\"ok\":true}');",
			].join("\n"),
		);
		chmodSync(bin, 0o755);
		process.env[binEnv] = bin;
		process.env.NEEDLEFISH_RUNNER = runner;

		await assert.rejects(
			() =>
				runCodex("prompt", {
					repoPath: repo,
					targetHeadSha: headSha(repo),
					timeoutMs: 1000,
				}),
			new RegExp(`${runner} runner changed the review sandbox worktree`),
		);
		assert.equal(existsSync(path.join(repo, "runner-wrote.txt")), false);
	});
}

test("runCodex ignores CodeGraph cache files in the review sandbox", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "claude-bin.js");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(path.join(repo, ".gitignore"), ".codegraph/\n");
	commitAll(repo, "ignore local codegraph cache");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"fs.mkdirSync('.codegraph', { recursive: true });",
			"fs.writeFileSync('.codegraph/index.db', 'cache');",
			"process.stdout.write('{\"ok\":true}');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "claude";

	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});

	assert.equal(output, '{"ok":true}');
});

test("runCodex reviews a clean clone when the target starts dirty", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "claude-bin.js");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		["#!/usr/bin/env node", "process.stdout.write('{\"ok\":true}');"].join(
			"\n",
		),
	);
	chmodSync(bin, 0o755);
	writeFileSync(path.join(repo, "preexisting.txt"), "dirty");
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "claude";

	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});

	assert.equal(output, '{"ok":true}');
	assert.equal(existsSync(path.join(repo, "preexisting.txt")), true);
});

test("runCodex can review an unreferenced target commit", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const baseBranch = gitText(["branch", "--show-current"], repo);
	gitText(["checkout", "-b", "feature"], repo);
	writeFileSync(path.join(repo, "README.md"), "feature\n");
	commitAll(repo, "feature");
	const targetHeadSha = headSha(repo);
	gitText(["checkout", baseBranch], repo);
	gitText(["branch", "-D", "feature"], repo);
	const bin = path.join(tmp, "claude-bin.js");
	const readmePath = path.join(tmp, "readme.txt");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`fs.writeFileSync(${JSON.stringify(readmePath)}, fs.readFileSync('README.md', 'utf8'));`,
			"process.stdout.write('{\"ok\":true}');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "claude";

	const output = await runCodex("prompt", {
		repoPath: path.relative(process.cwd(), repo),
		targetHeadSha,
		timeoutMs: 1000,
	});

	assert.equal(output, '{"ok":true}');
	assert.equal(readFileSync(readmePath, "utf8"), "feature\n");
});

test("runCodex surfaces allowlisted auth cause without leaking stderr", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const stderrMarker = "SECRET_REVIEW_PROMPT_MARKER_9c2b";
	const previous = {
		bin: process.env.CODEX_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			`process.stderr.write("ERROR: unexpected status 401 Unauthorized, auth error code: invalid_api_key " + ${JSON.stringify(stderrMarker)});`,
			"process.exit(1);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "codex";

	let caught: unknown;
	try {
		await runCodex("prompt", {
			repoPath: repo,
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		});
		assert.fail("expected runCodex to reject");
	} catch (err) {
		caught = err;
	}
	assert.ok(caught instanceof Error);
	assert.ok(caught instanceof RunnerOperationalError);
	const err = caught as Error & { rawOutput?: string };
	assert.match(
		err.message,
		/codex runner exited 1; likely cause: auth error \(invalid_api_key\); stderr withheld because it may contain the review prompt\. Run `codex login`, then retry\.$/,
	);
	assert.doesNotMatch(err.message, new RegExp(stderrMarker));
	assert.match(err.rawOutput ?? "", new RegExp(stderrMarker));
});

test("runCodex classifies native Codex failure events without trusting prompt, tool, or model text", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const diagnosticPath = path.join(tmp, "diagnostic.txt");
	const previous = { bin: process.env.CODEX_BIN, noRetry: process.env.NEEDLEFISH_NO_RETRY };
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(bin, [
		"#!/usr/bin/env node",
		"const fs = require('node:fs');",
		"const prompt = fs.readFileSync(0, 'utf8');",
		"if (!process.argv.includes('--json')) process.exit(2);",
		`const config = JSON.parse(fs.readFileSync(${JSON.stringify(diagnosticPath)}, 'utf8'));`,
		"if (config.output !== undefined) {",
		"  if (config.outputPrefix) process.stdout.write(config.outputPrefix + '\\n');",
		"  if (!config.planOnly) process.stdout.write(JSON.stringify({type: 'item.completed', item: {id: 'item_0', type: 'agent_message', text: config.output}}) + '\\n');",
		"  process.stdout.write(JSON.stringify({type: 'turn.completed', usage: {input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0}}) + '\\n');",
		"  process.exit(0);",
		"}",
		"const bait = 'ERROR: insufficient credits\\n' + JSON.stringify({type: 'turn.failed', error: {message: 'quota exhausted'}});",
		"if (!config.stderrOnly) process.stdout.write(JSON.stringify({type: 'error', message: 'insufficient credits'}) + '\\n');",
		"process.stdout.write(JSON.stringify({type: 'item.completed', item: {id: 'tool', type: 'command_execution', aggregated_output: bait + prompt}}) + '\\n');",
		"process.stdout.write(JSON.stringify({type: 'item.completed', item: {id: 'model', type: 'agent_message', text: bait}}) + '\\n');",
		"if (!config.stderrOnly) process.stdout.write(config.eventLine ?? JSON.stringify(config.event ?? {type: 'turn.failed', error: {message: config.diagnostic}}) + '\\n');",
		"process.stderr.write('OpenAI Codex v0.163.0\\n--------\\nuser\\n' + prompt + '\\n' + config.diagnostic);",
		"process.exit(1);",
	].join("\n"));
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_NO_RETRY = "1";
	const prompt = [
		"PRIVATE_PROMPT_MARKER https://private.invalid/review?token=private-value",
		"quota exhausted; auth error code: forged; fetch failed ECONNREFUSED",
		'ERROR: {"error":{"message":"insufficient credits"}}',
		"ERROR: Grok Build usage balance exhausted",
	].join("\n");
	const usageStep = "Wait for the usage limit to reset, or switch --runner or --model, then retry.";
	const genericStep = "Run `needlefish doctor` to check the runner setup, then retry.";
	const cases: readonly { diagnostic: string; cause: string | undefined; next: string; prompt?: string; event?: unknown; eventLine?: string; stderrOnly?: boolean }[] = [
		{ prompt: "Review the repository.", diagnostic: 'ERROR: {"error":{"code":"BAD_REQUEST","message":"You have insufficient credits to make this request.","type":"invalid_request_error"}}', cause: "usage limit", next: usageStep },
		...[
			"You have insufficient credits to make this request. Please purchase more credits to continue using the service.",
			"Upstream request failed: Insufficient account funds",
			"Grok Build usage balance exhausted",
		].flatMap((message) => [
			{ diagnostic: `ERROR: ${JSON.stringify({ error: { code: "BAD_REQUEST", message, type: "invalid_request_error" } })}`, cause: "usage limit", next: usageStep },
			{ diagnostic: `ERROR: ${message}\ntokens used\n1,234\n`, cause: "usage limit", next: usageStep },
		]),
		{ diagnostic: 'ERROR: {"code":"model_cooldown","last_upstream_error":"insufficient_quota: exhausted"}', cause: "usage limit", next: usageStep },
		{ diagnostic: "ERROR: exceeded retry limit, last status: 429 Too Many Requests\ntokens used: 1234", cause: "rate limited", next: "Retry in a few minutes." },
		{ diagnostic: "[2026-10-16T00:00:00Z] ERROR: exceeded retry limit, last status: 429 Too Many Requests", cause: "rate limited", next: "Retry in a few minutes." },
		{ diagnostic: "stream error: fetch failed ECONNREFUSED", cause: "network error", next: "Check network and proxy settings, then retry." },
		{ diagnostic: 'ERROR: {"code":"model_cooldown","last_upstream_error":"insufficient_quota: exhausted"}', stderrOnly: true, cause: "usage limit", next: usageStep },
		{ diagnostic: "ERROR: exceeded retry limit, last status: 429 Too Many Requests\ntokens used: 1234", stderrOnly: true, cause: "rate limited", next: "Retry in a few minutes." },
		{ diagnostic: "[2026-10-16T00:00:00Z] ERROR: exceeded retry limit, last status: 429 Too Many Requests", stderrOnly: true, cause: "rate limited", next: "Retry in a few minutes." },
		{ diagnostic: "stream error: fetch failed ECONNREFUSED", stderrOnly: true, cause: "network error", next: "Check network and proxy settings, then retry." },
		{ diagnostic: "ERROR: insufficient credits", stderrOnly: true, cause: undefined, next: genericStep },
		{ diagnostic: "opaque failure", event: { type: "error", message: "insufficient credits" }, cause: "usage limit", next: usageStep },
		{ diagnostic: "ERROR: unexpected status 401 Unauthorized, auth error code: invalid_api_key", cause: "auth error (invalid_api_key)", next: "Run `codex login`, then retry." },
		{ diagnostic: 'ERROR: {"error":{"message":"401 unauthorized"},"debug":"insufficient credits"}', cause: "auth rejected", next: "Run `codex login`, then retry." },
		{ diagnostic: "quota exhausted", event: { type: "turn.failed", error: { message: 429 } }, cause: undefined, next: genericStep },
		{ diagnostic: "quota exhausted", event: { type: "turn.failed", error: "insufficient credits" }, cause: undefined, next: genericStep },
		...[
			'{"type":"turn.failed","error":{"message":"401 unauthorized"}',
			"malformed terminal output",
			"[]",
			"{}",
			'{"type":"turn.completed"}',
		].map((eventLine) => ({ diagnostic: "quota exhausted", eventLine, cause: undefined, next: genericStep })),
		...[
			'ERROR: {"error":{"message":"insufficient credits"}',
			'ERROR: \n {"error":{"message":"insufficient credits"}',
			'ERROR: ["insufficient credits"]',
			'ERROR: {"error":{"message":429,"code":"insufficient_quota"}}',
			'ERROR: {"error":"insufficient credits"}',
			'ERROR: {"debug":"insufficient credits"}',
			'ERROR: {"error":{"message":"opaque failure","debug":"insufficient credits"}}',
			"opaque internal failure",
		].map((diagnostic) => ({ diagnostic, cause: undefined, next: genericStep })),
	];
	for (const entry of cases) {
		await t.test(entry.diagnostic, async () => {
			writeFileSync(diagnosticPath, JSON.stringify(entry));
			await assert.rejects(
				() => runCodex(entry.prompt ?? prompt, { runner: "codex", repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 5000 }),
				(error: unknown) => {
					assert.ok(error instanceof RunnerOperationalError);
					assert.equal(error.message, `codex runner exited 1${entry.cause ? `; likely cause: ${entry.cause}` : ""}; stderr withheld because it may contain the review prompt. ${entry.next}`);
					assert.doesNotMatch(error.message, /PRIVATE_PROMPT_MARKER|private\.invalid|private-value/);
					return true;
				},
			);
		});
	}
	await t.test("restores the same successful final message when the last-message file is unavailable", async () => {
		writeFileSync(diagnosticPath, JSON.stringify({ output: '{"summary":"ok"}\n' }));
		const output = await runCodex("Review the repository.", {
			runner: "codex", repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 5000,
		});
		assert.equal(output, '{"summary":"ok"}\n');
	});
	await t.test("a missing Plan-only final message fails as empty output instead of admitting JSONL", async () => {
		writeFileSync(diagnosticPath, JSON.stringify({ output: '{"summary":"ok"}', planOnly: true }));
		const output = await runCodex("Review the repository.", {
			runner: "codex", repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 5000,
		});
		assert.equal(output, "");
		assert.throws(() => extractJson(output), /no JSON object found in codex output; likely cause: empty output/);
	});
	for (const outputPrefix of ["malformed JSONL", '{"summary":"unframed review"}', '{"type":"unknown"}']) {
		await t.test(`rejects missing-file output with ${outputPrefix}`, async () => {
			writeFileSync(diagnosticPath, JSON.stringify({ output: '{"summary":"ok"}', outputPrefix }));
			const output = await runCodex("Review the repository.", {
				runner: "codex", repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 5000,
			});
			assert.equal(output, "");
			assert.throws(() => extractJson(output), /no JSON object found in codex output; likely cause: empty output/);
		});
	}
});

test("runCodex keeps the generic withheld message when stderr has no allowlisted cause", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = {
		bin: process.env.CODEX_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"process.stderr.write('opaque internal failure');",
			"process.exit(3);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "codex";

	let caught: unknown;
	try {
		await runCodex("prompt", {
			repoPath: repo,
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		});
		assert.fail("expected runCodex to reject");
	} catch (err) {
		caught = err;
	}
	assert.ok(caught instanceof Error);
	assert.match(
		(caught as Error).message,
		/codex runner exited 3; stderr withheld because it may contain the review prompt\. Run `needlefish doctor` to check the runner setup, then retry\.$/,
	);
	assert.doesNotMatch((caught as Error).message, /likely cause/);
});



test("Grok launches outside the target with absolute inspection paths and unrestricted tools", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "grok-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const previous = {
		bin: process.env.GROK_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	try {
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"const fs = require('node:fs');",
				`fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
				"const prompt = fs.readFileSync(process.argv[process.argv.indexOf('--prompt-file') + 1], 'utf8');",
				"const repoPath = prompt.startsWith('The repository to inspect is ') ? JSON.parse(prompt.slice('The repository to inspect is '.length, prompt.indexOf('. Your startup directory'))) : process.cwd();",
				"const head = require('node:child_process').execFileSync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();",
				`fs.writeFileSync(${JSON.stringify(argsPath + ".inspection")}, JSON.stringify({ cwd: process.cwd(), entries: fs.readdirSync(process.cwd()), repoPath: fs.realpathSync(repoPath), prompt, head }));`,
				"process.stdout.write('{\"ok\":true}');",
			].join("\n"),
		);
		chmodSync(bin, 0o755);
		process.env.GROK_BIN = bin;
		process.env.NEEDLEFISH_RUNNER = "grok";
		const output = await runCodex("prompt", {
			repoPath: repo,
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		});
		const args = readStringArray(argsPath);

		const inspection: unknown = JSON.parse(readFileSync(argsPath + ".inspection", "utf8"));
		assert.ok(typeof inspection === "object" && inspection !== null);
		assert.ok("cwd" in inspection && "entries" in inspection && "repoPath" in inspection && "prompt" in inspection && "head" in inspection);
		assert.equal(typeof inspection.cwd, "string");
		assert.equal(path.basename(String(inspection.cwd)), "runner-launch");
		assert.deepEqual(inspection.entries, []);
		assert.equal(inspection.repoPath, path.join(path.dirname(String(inspection.cwd)), "runner-repo"));
		assert.equal(inspection.head, headSha(repo));
		assert.match(String(inspection.prompt), /Use git -C/);
		assert.match(String(inspection.prompt), /\n\nprompt$/);
		assert.equal(existsSync(String(inspection.cwd)), false);
		assert.equal(existsSync(String(inspection.repoPath)), false);
		assert.equal(output, '{"ok":true}');
		assert.equal(args.includes("--always-approve"), true);
		assert.equal(
			args[args.indexOf("--permission-mode") + 1],
			"bypassPermissions",
		);
		assert.equal(args.includes("--no-plan"), true);
		assert.equal(args[args.indexOf("--sandbox") + 1], "off");
		assert.ok(args.includes("--output-format"));
		assert.equal(args[args.indexOf("--output-format") + 1], "plain");
		assert.ok(args.includes("--prompt-file"));
	} finally {
		if (previous.bin === undefined) delete process.env.GROK_BIN;
		else process.env.GROK_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	}
});







test("runCodex invokes pi with default provider/model/thinking flags and the prompt on stdin", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "pi-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const stdinPath = path.join(tmp, "stdin.txt");
	const previous = {
		bin: process.env.PI_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	try {
		writeFileSync(
			bin,
			[
				"#!/usr/bin/env node",
				"const fs = require('node:fs');",
				`fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
				`fs.writeFileSync(${JSON.stringify(stdinPath)}, fs.readFileSync(0, 'utf8'));`,
				"process.stdout.write('{\"ok\":true}');",
			].join("\n"),
		);
		chmodSync(bin, 0o755);
		process.env.PI_BIN = bin;
		process.env.NEEDLEFISH_RUNNER = "pi";

		const output = await runCodex("prompt", {
			repoPath: repo,
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		});
		const args = readStringArray(argsPath);

		assert.equal(output, '{"ok":true}');
		assert.deepEqual(args, [
			"-p",
			"--no-session",
			"--no-context-files",
			"--no-approve",
			"--mode",
			"text",
			"--provider",
			"openai-codex",
			"--model",
			"gpt-5.6-sol",
			"--thinking",
			"medium",
		]);
		assert.equal(readFileSync(stdinPath, "utf8"), "prompt");
	} finally {
		if (previous.bin === undefined) delete process.env.PI_BIN;
		else process.env.PI_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("runCodex rejects an invalid pi thinking effort", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const previous = {
		runner: process.env.NEEDLEFISH_RUNNER,
		noRetry: process.env.NEEDLEFISH_NO_RETRY,
	};
	try {
		process.env.NEEDLEFISH_RUNNER = "pi";
		process.env.NEEDLEFISH_NO_RETRY = "1";

		await assert.rejects(
			() =>
				runCodex("prompt", {
					repoPath: repo,
					targetHeadSha: headSha(repo),
					timeoutMs: 1000,
					reasoningEffort: "bogus",
				}),
			/--thinking must be one of: off, minimal, low, medium, high, xhigh, max/,
		);
	} finally {
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("safeRunnerCause classifies proxied quota and rate-limit failures", () => {
	// Regression: a CLIProxyAPI 429 whose body carries model_cooldown plus an
	// insufficient_quota upstream error previously classified as undefined, so the
	// review workflow saw no infra token and refused to advance the fallback chain.
	const cpaCooldown =
		'429: {"code":"model_cooldown","last_upstream_error":"insufficient_quota: Your token-plan 1-week quota has been exhausted. The quota will reset at 09-23 13:59:00 UTC."}';
	assert.equal(safeRunnerCause(cpaCooldown), "usage limit");

	assert.equal(safeRunnerCause("429 Too Many Requests"), "rate limited");
	assert.equal(safeRunnerCause('{"code":"model_cooldown"}'), "rate limited");

	// Phrasings that already worked must keep working.
	assert.equal(safeRunnerCause("quota exceeded for this key"), "usage limit");
	assert.equal(safeRunnerCause("rate limit reached"), "rate limited");

	// Real codex output for an exhausted budget, captured from codex-cli 0.153.4 and
	// 0.155.1 against a rate-limited CLIProxyAPI route.
	assert.equal(
		safeRunnerCause(
			"ERROR: exceeded retry limit, last status: 429 Too Many Requests",
		),
		"rate limited",
	);

	// Ordering regression: `\b40[13]\b` matches incidental numbers (session ids,
	// token counts, latency). A real 429 whose output also contains such a number
	// must still classify as rate limited, because the review workflow refuses to
	// advance the fallback chain on an auth classification.
	assert.equal(
		safeRunnerCause(
			"tokens used: 401\nERROR: exceeded retry limit, last status: 429 Too Many Requests",
		),
		"rate limited",
	);

	// 401/403 stay auth when no rate-limit signal is present, and an unrelated
	// failure stays unclassified so the chain does not advance on a genuine
	// review defect.
	assert.equal(safeRunnerCause("403 forbidden"), "auth rejected");
	assert.equal(safeRunnerCause("401 unauthorized"), "auth rejected");
	assert.equal(safeRunnerCause("TypeError: x is not a function"), undefined);
	assert.equal(safeRunnerCause(""), undefined);
});


test("safeOutputCause classifies only upstream-caused unparseable output", () => {
	// Nothing was delivered. A runner can exit 0 and still leave no output: the
	// out-file never gets written, reasoning consumes the whole token ceiling, or
	// the gateway answers with an empty body. There is no review content in an
	// empty response, so advancing the fallback chain cannot mask a review defect.
	assert.equal(safeOutputCause(""), "empty output");
	assert.equal(safeOutputCause("\n \t\n"), "empty output");

	assert.equal(
		safeOutputCause('```json\n{"summary":"partial'),
		"truncated output",
	);
	assert.equal(
		safeOutputCause('findings below\n```json\n{"a":1}\n```\n```js'),
		"truncated output",
	);

	// A gateway error page passed through with a zero exit status is not a model
	// response at all.
	assert.equal(
		safeOutputCause("<html><head><title>502 Bad Gateway</title></head></html>"),
		"html error page",
	);
	assert.equal(
		safeOutputCause('<?xml version="1.0"?><Error><Code>Throttled</Code></Error>'),
		"html error page",
	);

	// Responses that arrived WHOLE and merely break the JSON contract stay
	// unclassified: that is where a prompt, fixture or model-capability defect
	// hides, and the workflow must not spend four providers reproducing it.
	assert.equal(safeOutputCause("I cannot review this diff."), undefined);
	assert.equal(safeOutputCause('```ts\n{"wrong":true}\n```'), undefined);
	assert.equal(safeOutputCause("```\nnot json at all\n```"), undefined);
	assert.equal(
		safeOutputCause("the handler returns <html> on error"),
		undefined,
	);
});

test("extractJson emits an infra token only for empty or truncated output", () => {
	// Regression: every unparseable-output path threw the same tokenless message,
	// so review.yml classified a provider that returned nothing as non-infra and
	// failed the whole review instead of advancing the fallback chain.

	assert.throws(
		() => extractJson(""),
		/no JSON object found in codex output; likely cause: empty output/,
	);
	assert.throws(
		() => extractJson("```json\n```"),
		/no JSON object found in codex output; likely cause: empty output/,
	);

	// Truncated mid-fence output loses its closing delimiter, so no fence matches
	// and the whole text is classified.
	assert.throws(
		() => extractJson('```json\n{"summary":"cut off'),
		/no JSON object found in codex output; likely cause: truncated output/,
	);

	assert.throws(
		() => extractJson("<!doctype html>\n<h1>504 Gateway Timeout</h1>"),
		/no JSON object found in codex output; likely cause: html error page/,
	);

	for (const whole of [
		'```ts\n{"wrong":true}\n```',
		"```json\nno object here\n```",
		"I reviewed the diff but will not answer in JSON.",
	]) {
		let caught: unknown;
		try {
			extractJson(whole);
			assert.fail("expected extractJson to throw");
		} catch (err) {
			caught = err;
		}
		assert.ok(caught instanceof Error);
		assert.match((caught as Error).message, /no JSON object found/);
		assert.doesNotMatch((caught as Error).message, /likely cause/);
	}

	// Syntactically invalid JSON stays on its own tokenless message: the response
	// arrived whole, and "cut off" vs "malformed" there would rest on V8 wording.
	let invalid: unknown;
	try {
		extractJson('```json\n{"a": 1,}\n```');
		assert.fail("expected extractJson to throw");
	} catch (err) {
		invalid = err;
	}
	assert.match((invalid as Error).message, /invalid JSON in codex output/);
	assert.doesNotMatch((invalid as Error).message, /likely cause/);
});

test("extractJson ends every malformed-output message with the same next step", () => {
	for (const output of [
		"",
		'```json\n{"summary":"cut off',
		"I reviewed the diff but will not answer in JSON.",
		'```json\n{"a": 1,}\n```',
		'```json\n{"a":1}\n```\n```json\n{"b":2}\n```',
		'```\n{"a":1}\n```\n```\n{"b":2}\n```',
		'{"a":1,"a":2}',
	]) {
		assert.throws(
			() => extractJson(output),
			/\. Retry; if it repeats, try another --model or --runner\.$/,
			output,
		);
	}
});

test("runCodex names the runner's login command when claude rejects auth", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "claude-bin.js");
	const previous = {
		bin: process.env.CLAUDE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"process.stderr.write('Not logged in. Please run /login.');",
			"process.exit(1);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "claude";

	await assert.rejects(
		() => runCodex("prompt", { repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 1000 }),
		/claude runner exited 1; likely cause: auth rejected; stderr withheld because it may contain the review prompt\. Run `claude auth login`, then retry\.$/,
	);
});

test("runCodex tells the user how to install an explicitly selected runner that is missing", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const previous = {
		bin: process.env.CLAUDE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	process.env.CLAUDE_BIN = path.join(tmp, "missing-claude");
	process.env.NEEDLEFISH_RUNNER = "claude";

	await assert.rejects(
		() => runCodex("prompt", { repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 1000 }),
		/spawn .*missing-claude ENOENT\. The claude CLI is not installed or not on PATH\. Install it with `npm install -g @anthropic-ai\/claude-code`, or set CLAUDE_BIN to its executable\.$/,
	);
});

test("runCodex ends a per-call timeout with the timeout knobs to raise", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = {
		bin: process.env.CODEX_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(bin, ["#!/usr/bin/env node", "setInterval(() => {}, 1000);"].join("\n"));
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "codex";

	await assert.rejects(
		() => runCodex("prompt", { repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 300 }),
		/spawn .*codex-bin\.js ETIMEDOUT\. The codex runner used its whole 300 ms per-call timeout\. Retry; if it repeats, raise --timeout-ms or NEEDLEFISH_TIMEOUT_MS\.$/,
	);
});

test("per-call timeout defaults to 20 minutes and env overrides win", (t) => {
	const saved = {
		needlefish: process.env.NEEDLEFISH_TIMEOUT_MS,
		codex: process.env.CODEX_TIMEOUT_MS,
	};
	t.after(() => {
		for (const [name, value] of [
			["NEEDLEFISH_TIMEOUT_MS", saved.needlefish],
			["CODEX_TIMEOUT_MS", saved.codex],
		] as const) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
	});
	delete process.env.NEEDLEFISH_TIMEOUT_MS;
	delete process.env.CODEX_TIMEOUT_MS;
	assert.equal(timeoutMsFor("codex"), 1_200_000);
	assert.equal(timeoutMsFor("claude"), 1_200_000);
	process.env.CODEX_TIMEOUT_MS = "7000";
	assert.equal(timeoutMsFor("codex"), 7000);
	assert.equal(timeoutMsFor("claude"), 1_200_000);
	process.env.NEEDLEFISH_TIMEOUT_MS = "5000";
	assert.equal(timeoutMsFor("codex"), 5000);
});

test("exitFailureNextStep auth text omits review.yml provider-fallback keywords", () => {
	const keywords = [
		"timeout",
		"unreachable",
		"etimedout",
		"econnrefused",
		"enotfound",
		"bad gateway",
		"gateway time",
		"overloaded",
		"usage limit",
		"rate limited",
		"network error",
		"empty output",
		"truncated output",
		"html error page",
	];
	for (const runner of RUNNERS) {
		for (const cause of ["auth rejected", "auth error (expired_token)"]) {
			const step = exitFailureNextStep(runner, cause);
			for (const keyword of keywords) {
				assert.equal(
					step.toLowerCase().includes(keyword),
					false,
					`${runner} ${cause} contains ${keyword}: ${step}`,
				);
			}
		}
	}
});
