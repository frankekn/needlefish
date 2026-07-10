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

test("runCodex invokes claude in non-interactive plan mode", async (t) => {
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
	assert.deepEqual(args.slice(0, 7), [
		"--print",
		"--output-format",
		"text",
		"--permission-mode",
		"plan",
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
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowOpenCode: process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowOpenCode === undefined)
			delete process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = previous.allowOpenCode;
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
	process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = "1";

	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	const args = readStringArray(argsPath);

	assert.equal(output, '{"ok":true}');
	assert.deepEqual(args.slice(0, 5), [
		"run",
		"--format",
		"json",
		"--pure",
		"--dir",
	]);
	assert.notEqual(args[5], repo);
	assert.equal(args[6], "--file");
	assert.equal(
		args.at(-1),
		"Use the attached prompt file as your complete instruction.",
	);
	assert.equal(args.includes("prompt"), false);
	assert.equal(readFileSync(inputPath, "utf8"), "prompt");
	assert.equal(readFileSync(stdinPath, "utf8"), "");
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
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowOpenCode: process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowOpenCode === undefined)
			delete process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = previous.allowOpenCode;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"process.stdout.write('not json');",
			"process.stderr.write('boom');",
			"process.exit(2);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "opencode";
	process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = "1";

	await assert.rejects(
		() =>
			runCodex("prompt", {
				repoPath: repo,
				targetHeadSha: headSha(repo),
				timeoutMs: 1000,
			}),
		/opencode runner exited 2: boom/,
	);
});

test("runCodex passes grok plan permission mode by default", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "grok-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const previous = {
		bin: process.env.GROK_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowUnsandboxed: process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED,
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
		delete process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED;

		const output = await runCodex("prompt", {
			repoPath: repo,
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		});
		const args = readStringArray(argsPath);

		assert.equal(output, '{"ok":true}');
		const flagIndex = args.indexOf("--permission-mode");
		assert.notEqual(flagIndex, -1);
		assert.equal(args[flagIndex + 1], "plan");
	} finally {
		if (previous.bin === undefined) delete process.env.GROK_BIN;
		else process.env.GROK_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowUnsandboxed === undefined)
			delete process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED;
		else
			process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED = previous.allowUnsandboxed;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("runCodex omits grok permission mode when unsandboxed env is set", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "grok-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const previous = {
		bin: process.env.GROK_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowUnsandboxed: process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED,
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
		process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED = "1";

		const output = await runCodex("prompt", {
			repoPath: repo,
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		});
		const args = readStringArray(argsPath);

		assert.equal(output, '{"ok":true}');
		assert.equal(args.includes("--permission-mode"), false);
		assert.ok(args.includes("--output-format"));
		assert.equal(args[args.indexOf("--output-format") + 1], "plain");
		assert.ok(args.includes("--prompt-file"));
	} finally {
		if (previous.bin === undefined) delete process.env.GROK_BIN;
		else process.env.GROK_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowUnsandboxed === undefined)
			delete process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED;
		else
			process.env.NEEDLEFISH_ALLOW_GROK_UNSANDBOXED = previous.allowUnsandboxed;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("runCodex refuses the opencode runner without explicit opt-in", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowOpenCode: process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowOpenCode === undefined)
			delete process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = previous.allowOpenCode;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		["#!/usr/bin/env node", "process.stdout.write('{\"ok\":true}');"].join(
			"\n",
		),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_RUNNER = "opencode";
	delete process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER;

	await assert.rejects(
		() =>
			runCodex("prompt", {
				repoPath: repo,
				targetHeadSha: headSha(repo),
				timeoutMs: 1000,
			}),
		/NEEDLEFISH_ALLOW_OPENCODE_RUNNER/,
	);
});

test("runCodex allows opencode when explicitly opted in", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const argsPath = path.join(tmp, "args.json");
	const inputPath = path.join(tmp, "prompt-copy.txt");
	const stdinPath = path.join(tmp, "stdin.txt");
	const previous = {
		bin: process.env.OPENCODE_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowOpenCode: process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
		else process.env.OPENCODE_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowOpenCode === undefined)
			delete process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = previous.allowOpenCode;
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
	process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = "1";

	const output = await runCodex("prompt", {
		repoPath: repo,
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	const args = readStringArray(argsPath);

	assert.equal(output, '{"ok":true}');
	assert.deepEqual(args.slice(0, 5), [
		"run",
		"--format",
		"json",
		"--pure",
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
		allowPi: process.env.NEEDLEFISH_ALLOW_PI_RUNNER,
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
		process.env.NEEDLEFISH_ALLOW_PI_RUNNER = "1";

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
			"--tools",
			"read,grep,find,ls",
		]);
		assert.equal(readFileSync(stdinPath, "utf8"), "prompt");
	} finally {
		if (previous.bin === undefined) delete process.env.PI_BIN;
		else process.env.PI_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowPi === undefined)
			delete process.env.NEEDLEFISH_ALLOW_PI_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_PI_RUNNER = previous.allowPi;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("runCodex refuses the pi runner without explicit opt-in", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "pi-bin.js");
	const previous = {
		bin: process.env.PI_BIN,
		runner: process.env.NEEDLEFISH_RUNNER,
		allowPi: process.env.NEEDLEFISH_ALLOW_PI_RUNNER,
	};
	try {
		writeFileSync(
			bin,
			["#!/usr/bin/env node", "process.stdout.write('{\"ok\":true}');"].join(
				"\n",
			),
		);
		chmodSync(bin, 0o755);
		process.env.PI_BIN = bin;
		process.env.NEEDLEFISH_RUNNER = "pi";
		delete process.env.NEEDLEFISH_ALLOW_PI_RUNNER;

		await assert.rejects(
			() =>
				runCodex("prompt", {
					repoPath: repo,
					targetHeadSha: headSha(repo),
					timeoutMs: 1000,
				}),
			/NEEDLEFISH_ALLOW_PI_RUNNER/,
		);
	} finally {
		if (previous.bin === undefined) delete process.env.PI_BIN;
		else process.env.PI_BIN = previous.bin;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.allowPi === undefined)
			delete process.env.NEEDLEFISH_ALLOW_PI_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_PI_RUNNER = previous.allowPi;
		rmSync(tmp, { recursive: true, force: true });
	}
});

test("runCodex rejects an invalid pi thinking effort", async () => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const previous = {
		runner: process.env.NEEDLEFISH_RUNNER,
		allowPi: process.env.NEEDLEFISH_ALLOW_PI_RUNNER,
		noRetry: process.env.NEEDLEFISH_NO_RETRY,
	};
	try {
		process.env.NEEDLEFISH_RUNNER = "pi";
		process.env.NEEDLEFISH_ALLOW_PI_RUNNER = "1";
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
		if (previous.allowPi === undefined)
			delete process.env.NEEDLEFISH_ALLOW_PI_RUNNER;
		else process.env.NEEDLEFISH_ALLOW_PI_RUNNER = previous.allowPi;
		if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
		rmSync(tmp, { recursive: true, force: true });
	}
});
