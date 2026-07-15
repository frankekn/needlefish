import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodex } from "./codex";
import { headSha, initRepo } from "./codex-runner-test-fixtures";

const ENV_NAMES = [
	"KIRO_BIN",
	"KIRO_API_KEY",
	"NEEDLEFISH_EPHEMERAL_HOME",
	"NEEDLEFISH_KIRO_AUTH_DB",
	"NEEDLEFISH_NO_RETRY",
	"NEEDLEFISH_TEST_SECRET",
	"TMPDIR",
] as const;

type SavedEnv = Readonly<Record<(typeof ENV_NAMES)[number], string | undefined>>;

function saveEnv(): SavedEnv {
	return Object.fromEntries(
		ENV_NAMES.map((name) => [name, process.env[name]]),
	) as unknown as SavedEnv;
}

function restoreEnv(saved: SavedEnv): void {
	for (const name of ENV_NAMES) {
		const value = saved[name];
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
}

function clearKiroEnv(): void {
	for (const name of ENV_NAMES) delete process.env[name];
}

function writeKiroStub(bin: string, body: readonly string[]): void {
	writeFileSync(
		bin,
		["#!/usr/bin/env node", "const fs = require('node:fs');", ...body].join("\n"),
	);
	chmodSync(bin, 0o755);
}

function fixture(t: test.TestContext): {
	readonly tmp: string;
	readonly repo: string;
	readonly bin: string;
} {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-kiro-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "kiro-bin.js");
	const saved = saveEnv();
	clearKiroEnv();
	process.env.KIRO_BIN = bin;
	process.env.NEEDLEFISH_NO_RETRY = "1";
	t.after(() => {
		restoreEnv(saved);
		rmSync(tmp, { recursive: true, force: true });
	});
	return { tmp, repo, bin };
}

test("runCodex invokes Kiro through a private read-only custom agent", async (t) => {
	const { tmp, repo, bin } = fixture(t);
	const dumpPath = path.join(tmp, "dump.json");
	process.env.KIRO_API_KEY = "kiro-test-key";
	process.env.NEEDLEFISH_KIRO_AUTH_DB = path.join(tmp, "must-not-pass.sqlite3");
	process.env.NEEDLEFISH_TEST_SECRET = "must-not-pass";
	writeKiroStub(bin, [
		"const path = require('node:path');",
		"const { fileURLToPath } = require('node:url');",
		"const args = process.argv.slice(2);",
		"const agentName = args[args.indexOf('--agent') + 1];",
		"const agentPath = path.join(process.env.KIRO_HOME, 'agents', agentName + '.json');",
		"const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));",
		"const promptPath = fileURLToPath(agent.prompt);",
		`fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({`,
		"  args, cwd: process.cwd(), stdin: fs.readFileSync(0, 'utf8'),",
		"  env: process.env, agent, prompt: fs.readFileSync(promptPath, 'utf8'),",
		"  promptMode: fs.statSync(promptPath).mode & 0o777,",
		"  agentMode: fs.statSync(agentPath).mode & 0o777,",
		"  settings: JSON.parse(fs.readFileSync(path.join(process.env.KIRO_HOME, 'settings', 'cli.json'), 'utf8'))",
		"}));",
		"process.stdout.write('\\u001b[32m{\"ok\":true}\\u001b[0m\\r\\n');",
	]);
	const raw: string[] = [];

	const output = await runCodex("full needlefish prompt", {
		repoPath: repo,
		runner: "kiro",
		model: "gpt-5.6-luna",
		reasoningEffort: "xhigh",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
		onRaw: (value) => raw.push(value),
	});
	const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, unknown>;
	const args = dump.args as string[];
	const env = dump.env as Record<string, string>;
	const agent = dump.agent as Record<string, unknown>;
	const settings = dump.settings as Record<string, unknown>;

	assert.equal(output, '{"ok":true}');
	assert.deepEqual(args.slice(0, 8), [
		"chat", "--no-interactive", "--wrap", "never", "--agent", args[5], "--trust-tools=read,grep", "--model",
	]);
	assert.match(args[5], /^needlefish-[a-f0-9-]+$/);
	assert.deepEqual(args.slice(8, 11), ["gpt-5.6-luna", "--effort", "xhigh"]);
	assert.match(
		args.at(-1) ?? "",
		/Follow the complete review instructions in your agent prompt/,
	);
	assert.equal(args.includes("full needlefish prompt"), false);
	assert.equal(dump.stdin, "");
	const loadedPrompt = dump.prompt as string;
	assert.match(
		loadedPrompt,
		/^Review repository root \(use absolute paths for read\/grep\): /,
	);
	assert.ok(loadedPrompt.includes(`${path.sep}runner-repo\n\n`));
	assert.ok(loadedPrompt.endsWith("full needlefish prompt"));
	assert.equal(dump.promptMode, 0o600);
	assert.equal(dump.agentMode, 0o600);
	assert.notEqual(dump.cwd, repo);
	assert.deepEqual(agent.tools, ["read", "grep"]);
	assert.deepEqual(agent.allowedTools, ["read", "grep"]);
	assert.deepEqual(agent.resources, []);
	assert.equal(settings["app.disableAutoupdates"], true);
	assert.equal(settings["chat.disableInheritingDefaultResources"], true);
	assert.equal(env.KIRO_API_KEY, "kiro-test-key");
	assert.equal(env.KIRO_NO_AUTO_UPDATE, "1");
	assert.equal(env.KIRO_LOG_NO_COLOR, "1");
	assert.ok(env.KIRO_CHAT_LOG_FILE.endsWith(`${path.sep}kiro.log`));
	assert.equal(env.NEEDLEFISH_KIRO_AUTH_DB, undefined);
	assert.equal(env.NEEDLEFISH_TEST_SECRET, undefined);
	assert.equal(existsSync(env.KIRO_HOME), false);
	assert.ok(raw[0]?.includes("\u001b[32m"), "raw transcript must retain ANSI stdout");
});

test("guarded Kiro API-key mode uses empty disposable home and data dirs", async (t) => {
	const { tmp, repo, bin } = fixture(t);
	const dumpPath = path.join(tmp, "dirs.json");
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.KIRO_API_KEY = "kiro-test-key";
	writeKiroStub(bin, [
		`fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({`,
		"  home: process.env.HOME, userProfile: process.env.USERPROFILE,",
		"  kiroHome: process.env.KIRO_HOME, data: process.env.KIRO_DATA_DIR,",
		"  files: fs.readdirSync(process.env.KIRO_DATA_DIR)",
		"}));",
		"process.stdout.write('{\"ok\":true}');",
	]);

	await runCodex("prompt", {
		repoPath: repo,
		runner: "kiro",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as {
		home: string;
		userProfile: string;
		kiroHome: string;
		data: string;
		files: string[];
	};
	assert.deepEqual(dump.files, []);
	assert.equal(dump.home, dump.userProfile);
	assert.ok(dump.home.endsWith(`${path.sep}home`));
	assert.equal(existsSync(dump.home), false);
	assert.equal(existsSync(dump.kiroHome), false);
	assert.equal(existsSync(dump.data), false);
});

test("guarded Kiro copies the explicit auth DB with mode 0600 and disposes it", async (t) => {
	const { tmp, repo, bin } = fixture(t);
	const authDb = path.join(tmp, "auth.sqlite3");
	const dumpPath = path.join(tmp, "auth-dump.json");
	writeFileSync(authDb, "sanitized-auth");
	chmodSync(authDb, 0o644);
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_KIRO_AUTH_DB = authDb;
	writeKiroStub(bin, [
		"const path = require('node:path');",
		"const db = path.join(process.env.HOME, '.local', 'share', 'kiro-cli', 'data.sqlite3');",
		`fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({`,
		"  genericHome: process.env.HOME, home: process.env.KIRO_HOME, data: process.env.KIRO_DATA_DIR,",
		"  content: fs.readFileSync(db, 'utf8'),",
		"  mode: fs.statSync(db).mode & 0o777, symlink: fs.lstatSync(db).isSymbolicLink(),",
		"  parentAuth: process.env.NEEDLEFISH_KIRO_AUTH_DB",
		"}));",
		"process.stdout.write('{\"ok\":true}');",
	]);

	await runCodex("prompt", {
		repoPath: repo,
		runner: "kiro",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as {
		genericHome: string;
		home: string;
		data: string;
		content: string;
		mode: number;
		symlink: boolean;
		parentAuth?: string;
	};
	assert.equal(dump.content, "sanitized-auth");
	assert.equal(dump.mode, 0o600);
	assert.equal(dump.symlink, false);
	assert.equal(dump.parentAuth, undefined);
	assert.equal(readFileSync(authDb, "utf8"), "sanitized-auth");
	assert.equal(existsSync(dump.genericHome), false);
	assert.equal(existsSync(dump.home), false);
	assert.equal(existsSync(dump.data), false);
});

test("guarded Kiro fails closed without API key or explicit auth DB", async (t) => {
	const { tmp, repo } = fixture(t);
	const scratch = path.join(tmp, "scratch");
	mkdirSync(scratch);
	process.env.TMPDIR = scratch;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";

	await assert.rejects(
		() => runCodex("prompt", {
			repoPath: repo,
			runner: "kiro",
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		}),
		/NEEDLEFISH_KIRO_AUTH_DB.*required.*KIRO_API_KEY/i,
	);
	assert.deepEqual(readdirSync(scratch), []);
});

test("Kiro failure stdout and stderr ride the generic raw transcript", async (t) => {
	const { repo, bin } = fixture(t);
	writeKiroStub(bin, [
		"process.stdout.write('partial-kiro-output');",
		"process.stderr.write('kiro-failure-detail');",
		"process.exit(2);",
	]);
	const failedRaw: string[] = [];

	await assert.rejects(
		() => runCodex("prompt", {
			repoPath: repo,
			runner: "kiro",
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
			onFailedRaw: (raw) => failedRaw.push(raw),
		}),
		/kiro runner exited 2: kiro-failure-detail/,
	);
	assert.deepEqual(failedRaw, ["partial-kiro-output\nkiro-failure-detail"]);
});
