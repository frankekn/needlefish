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
import { runCodex } from "./codex";
import {
	commitAll,
	gitText,
	headSha,
	initRepo,
	readStringArray,
} from "./codex-runner-test-fixtures";

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

test("runCodex extracts opencode json text output", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const inputPath = path.join(tmp, "prompt-copy.txt");
	const stdinPath = path.join(tmp, "stdin.txt");
	const configPath = path.join(tmp, "config.txt");
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const args = process.argv.slice(2);",
			`fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
			`fs.writeFileSync(${JSON.stringify(configPath)}, process.env.OPENCODE_CONFIG_CONTENT || '');`,
			`fs.writeFileSync(${JSON.stringify(stdinPath)}, fs.readFileSync(0, 'utf8'));`,
			"const promptFile = args[args.indexOf('--file') + 1];",
			`fs.writeFileSync(${JSON.stringify(inputPath)}, fs.readFileSync(promptFile, 'utf8'));`,
			"process.stdout.write('warning: ignored noise\\n');",
			"process.stdout.write(JSON.stringify({ type: 'text', part: { text: '{\"ok\":true}' } }) + '\\n');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "opencode";

	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	const args = readStringArray(argsPath);

	assert.equal(output, '{"ok":true}');
	assert.equal(args.includes("--auto"), true);
	assert.deepEqual(args.slice(0, 6), [
		"run",
		"--format",
		"json",
		"--pure",
		"--auto",
		"--dir",
	]);
	assert.notEqual(args[6], repo);
	assert.equal(args[7], "--file");
	assert.equal(
		args.at(-1),
		"Use the attached prompt file as your complete instruction.",
	);
	assert.equal(args.includes("prompt"), false);
	assert.equal(readFileSync(inputPath, "utf8"), "prompt");
	assert.equal(readFileSync(stdinPath, "utf8"), "");
	assert.deepEqual(JSON.parse(readFileSync(configPath, "utf8")), {
		permission: "allow",
		agent: { build: { permission: "allow" } },
	});
});

test("runCodex retries an opencode attempt that stops producing output", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const attemptsPath = path.join(tmp, "attempts.txt");
	const previous = {
		bin: process.env.OPENCODE_BIN,
		idleTimeout: process.env.OPENCODE_IDLE_TIMEOUT_MS,
		noRetry: process.env.NEEDLEFISH_NO_RETRY,
		retry: process.env.NEEDLEFISH_RETRY_MS,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.idleTimeout === undefined)
			delete process.env.OPENCODE_IDLE_TIMEOUT_MS;
		else process.env.OPENCODE_IDLE_TIMEOUT_MS = previous.idleTimeout;
		if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
		if (previous.retry === undefined) delete process.env.NEEDLEFISH_RETRY_MS;
		else process.env.NEEDLEFISH_RETRY_MS = previous.retry;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`const attemptsPath = ${JSON.stringify(attemptsPath)};`,
			"const attempt = fs.existsSync(attemptsPath) ? Number(fs.readFileSync(attemptsPath, 'utf8')) + 1 : 1;",
			"fs.writeFileSync(attemptsPath, String(attempt));",
			"if (attempt === 1) setInterval(() => {}, 1000);",
			"else process.stdout.write(JSON.stringify({ type: 'text', part: { text: '{\\\"ok\\\":true}' } }) + '\\n');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.OPENCODE_IDLE_TIMEOUT_MS = "100";
	delete process.env.NEEDLEFISH_NO_RETRY;
	process.env.NEEDLEFISH_RETRY_MS = "1";
	process.env.NEEDLEFISH_RUNNER = "opencode";

	const startedAt = Date.now();
	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 2000,
	});

	assert.ok(Date.now() - startedAt < 1000);
	assert.equal(output, '{"ok":true}');
	assert.equal(readFileSync(attemptsPath, "utf8"), "2");
});

test("runCodex rejects non-codex runners that dirty the target repo", async (t) => {
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
			"const fs = require('node:fs');",
			"fs.writeFileSync('runner-wrote.txt', 'dirty');",
			"process.stdout.write('{\"ok\":true}');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CLAUDE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "claude";

	await assert.rejects(
		() =>
			runCodex("prompt", {
				repoPath: repo,
				targetHeadSha: headSha(repo),
				timeoutMs: 1000,
			}),
		/claude runner changed the review sandbox worktree/,
	);
	assert.equal(existsSync(path.join(repo, "runner-wrote.txt")), false);
});

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

test("runCodex reports opencode exit errors before parsing stdout", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const stderrMarker = "SECRET_REVIEW_PROMPT_MARKER_7f6a";
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"process.stdout.write('not json');",
			`process.stderr.write(${JSON.stringify(stderrMarker)});`,
			"process.exit(2);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "opencode";

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
	const err = caught as Error & { rawOutput?: string };
	assert.match(
		err.message,
		/opencode runner exited 2; stderr withheld because it may contain the review prompt/,
	);
	assert.doesNotMatch(err.message, new RegExp(stderrMarker));
	assert.match(
		err.rawOutput ?? "",
		new RegExp(stderrMarker),
	);
	assert.equal(Object.keys(err).includes("rawOutput"), false);
});

test("runCodex omits grok permission restrictions by default", async () => {
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

test("runCodex invokes opencode without an opt-in gate", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const inputPath = path.join(tmp, "prompt-copy.txt");
	const stdinPath = path.join(tmp, "stdin.txt");
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const args = process.argv.slice(2);",
			`fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
			`fs.writeFileSync(${JSON.stringify(stdinPath)}, fs.readFileSync(0, 'utf8'));`,
			"const promptFile = args[args.indexOf('--file') + 1];",
			`fs.writeFileSync(${JSON.stringify(inputPath)}, fs.readFileSync(promptFile, 'utf8'));`,
			"process.stdout.write('warning: ignored noise\\n');",
			"process.stdout.write(JSON.stringify({ type: 'text', part: { text: '{\"ok\":true}' } }) + '\\n');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "opencode";

	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	const args = readStringArray(argsPath);

	assert.equal(output, '{"ok":true}');
	assert.equal(args.includes("--auto"), true);
	assert.deepEqual(args.slice(0, 6), [
		"run",
		"--format",
		"json",
		"--pure",
		"--auto",
		"--dir",
	]);
	assert.equal(readFileSync(inputPath, "utf8"), "prompt");
	assert.equal(readFileSync(stdinPath, "utf8"), "");
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
