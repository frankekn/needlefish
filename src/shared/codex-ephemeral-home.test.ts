import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareEphemeralHome, runCodex } from "./codex";
import { headSha, initRepo } from "./codex-runner-test-fixtures";

// S3.1: flag on + non-claude → child HOME is <tmp>/home under os.tmpdir(),
// NOT the real HOME; after the invocation returns, that dir is gone.
test("runCodex ephemeral HOME: child HOME is <tmp>/home and is disposed after the call", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const homeDump = path.join(tmp, "home-dump.json");
	// CI-safe: never depend on the real ~/.codex — plant the auth sources in a
	// fake parent HOME (ubuntu runners have no codex auth).
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	mkdirSync(path.join(fakeHome, ".codex"));
	writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
	writeFileSync(path.join(fakeHome, ".codex", "config.toml"), 'model = "x"');
	const previous = {
		bin: process.env.CODEX_BIN,
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		retry: process.env.NEEDLEFISH_NO_RETRY,
		home: process.env.HOME,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.retry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.retry;
		process.env.HOME = previous.home;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`const homeDump = ${JSON.stringify(homeDump)};`,
			"fs.writeFileSync(homeDump, JSON.stringify({ home: process.env.HOME ?? null }));",
			"fs.writeFileSync(out, '{\"ok\":true}');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.HOME = fakeHome;

	await runCodex("prompt", {
		repoPath: repo,
		runner: "codex",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});

	const dump = JSON.parse(readFileSync(homeDump, "utf8")) as {
		home: string | null;
	};
	assert.ok(dump.home, "child HOME must be set");
	assert.notEqual(
		dump.home,
		fakeHome,
		"child HOME must NOT be the parent's HOME",
	);
	assert.ok(
		dump.home.startsWith(path.join(os.tmpdir(), "needlefish-")),
		`child HOME must live under the needlefish- tmp prefix, got: ${dump.home}`,
	);
	assert.ok(
		dump.home.endsWith(`${path.sep}home`),
		"child HOME must be the <tmp>/home subdir",
	);
	// After the invocation returns, the ephemeral HOME dir is gone (rmSync'd tmp).
	assert.equal(
		existsSync(dump.home),
		false,
		"ephemeral HOME dir must not exist after the call",
	);
});

// S3.2: auth material — the ephemeral HOME exposes exactly the minimal auth
// files as copies (never symlinks); nothing session/history-named is present.
test("prepareEphemeralHome copies only the minimal auth files, never symlinks", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const realHome = process.env.HOME;
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = realHome;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	// Plant the minimal codex auth files in the fake HOME, plus a session dir
	// and a history file that must NOT be linked.
	mkdirSync(path.join(fakeHome, ".codex"));
	writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
	writeFileSync(path.join(fakeHome, ".codex", "config.toml"), 'model = "x"');
	mkdirSync(path.join(fakeHome, ".codex", "sessions"));
	writeFileSync(path.join(fakeHome, ".codex", "history.jsonl"), "{}");

	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";

	const home = prepareEphemeralHome("codex", tmp);
	assert.ok(home, "expected an ephemeral home path");
	assert.equal(home, path.join(tmp, "home"));

	// Auth files exist as COPIES — regular files, never symlinks (a symlink
	// would be a write-through channel into the real HOME).
	for (const rel of [".codex/auth.json", ".codex/config.toml"]) {
		const copied = path.join(home, rel);
		assert.equal(existsSync(copied), true, `${rel} must be copied`);
		assert.equal(
			lstatSync(copied).isSymbolicLink(),
			false,
			`${rel} must NOT be a symlink`,
		);
		assert.equal(
			lstatSync(copied).isFile(),
			true,
			`${rel} must be a regular file`,
		);
		assert.equal(
			readFileSync(copied, "utf8"),
			readFileSync(path.join(fakeHome, rel), "utf8"),
			`${rel} content must match the source`,
		);
	}
	// Session/history dirs/files must NOT exist in the ephemeral HOME.
	assert.equal(
		existsSync(path.join(home, ".codex", "sessions")),
		false,
		"sessions dir must not be linked",
	);
	assert.equal(
		existsSync(path.join(home, ".codex", "history.jsonl")),
		false,
		"history file must not be linked",
	);
});

// S3.3: fail-closed — flag on + missing auth source → throw naming the file,
// never silently fall back to the real HOME.
test("prepareEphemeralHome fail-closed: missing auth source throws naming the file", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const realHome = process.env.HOME;
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = realHome;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	// Fake HOME with NO codex auth files.
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";

	assert.throws(
		() => prepareEphemeralHome("codex", tmp),
		/required auth source is missing: .*\.codex\/auth\.json.*Refusing to fall back/,
	);
	// Fail-closed: the function threw rather than silently using the real HOME.
	// (The <tmp>/home dir may have been created before the throw; it is inside
	// the per-invocation tmp which the caller rmSync's, so no separate cleanup
	// is needed — the disposability invariant holds.)
});

// Disposability under failure: a fail-closed preparation throw inside runCodex
// must still dispose the per-invocation tmp dir — a leaked dir would leave any
// already-copied credentials on disk.
test("runCodex ephemeral HOME fail-closed: preparation failure leaves no tmp dir behind", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	// Fake HOME with NO codex auth files → prepareEphemeralHome throws.
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	// Redirect os.tmpdir() to a test-owned dir so the invocation dir (and any
	// leak) is observable in isolation from parallel tests.
	const scratchTmp = path.join(tmp, "scratch-tmpdir");
	mkdirSync(scratchTmp);
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		retry: process.env.NEEDLEFISH_NO_RETRY,
		home: process.env.HOME,
		tmpdir: process.env.TMPDIR,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.retry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.retry;
		process.env.HOME = previous.home;
		if (previous.tmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous.tmpdir;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.TMPDIR = scratchTmp;

	await assert.rejects(
		() =>
			runCodex("prompt", {
				repoPath: repo,
				runner: "codex",
				targetHeadSha: headSha(repo),
				timeoutMs: 1000,
			}),
		/required auth source is missing/,
	);
	assert.deepEqual(
		readdirSync(scratchTmp),
		[],
		"a failed preparation must not leak its invocation dir",
	);
});

// S3.4: claude exemption — flag on + runner claude → real HOME retained.
test("prepareEphemeralHome claude exemption keeps real HOME under the flag", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const previous = { ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME };
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		rmSync(tmp, { recursive: true, force: true });
	});
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	const home = prepareEphemeralHome("claude", tmp);
	assert.equal(
		home,
		undefined,
		"claude must keep the real HOME (no ephemeral override)",
	);
	assert.equal(
		existsSync(path.join(tmp, "home")),
		false,
		"no <tmp>/home should be created for claude",
	);
});

// Flag off → no isolation (returns undefined), regardless of runner.
test("prepareEphemeralHome returns undefined when the flag is off", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const previous = process.env.NEEDLEFISH_EPHEMERAL_HOME;
	t.after(() => {
		if (previous === undefined) delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous;
		rmSync(tmp, { recursive: true, force: true });
	});
	delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
	assert.equal(prepareEphemeralHome("codex", tmp), undefined);
	assert.equal(existsSync(path.join(tmp, "home")), false);
});

// S3.7: disposability — after a stubbed end-to-end draw, the ephemeral HOME
// (and its parent invocation tmp) are gone. We capture the exact child HOME
// path from the stub and assert it no longer exists after the call returns.
// (Scanning all of os.tmpdir() is racy under the shared suite; the exact-path
// check is deterministic and pins the same invariant.)
test("runCodex ephemeral HOME: invocation tmp + home disposed after a stubbed draw", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const homeDump = path.join(tmp, "home-dump.json");
	// CI-safe: plant auth sources in a fake parent HOME (no real ~/.codex).
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	mkdirSync(path.join(fakeHome, ".codex"));
	writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
	writeFileSync(path.join(fakeHome, ".codex", "config.toml"), 'model = "x"');
	const previous = {
		bin: process.env.CODEX_BIN,
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		retry: process.env.NEEDLEFISH_NO_RETRY,
		home: process.env.HOME,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.retry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
		else process.env.NEEDLEFISH_NO_RETRY = previous.retry;
		process.env.HOME = previous.home;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
			`const homeDump = ${JSON.stringify(homeDump)};`,
			"fs.writeFileSync(homeDump, JSON.stringify({ home: process.env.HOME ?? null }));",
			"fs.writeFileSync(out, '{\"ok\":true}');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.HOME = fakeHome;

	await runCodex("prompt", {
		repoPath: repo,
		runner: "codex",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});

	const dump = JSON.parse(readFileSync(homeDump, "utf8")) as {
		home: string | null;
	};
	assert.ok(dump.home, "child HOME must have been set");
	// The ephemeral HOME and its parent invocation tmp dir are both gone.
	assert.equal(
		existsSync(dump.home),
		false,
		"ephemeral HOME must be disposed after the draw",
	);
	assert.equal(
		existsSync(path.dirname(dump.home)),
		false,
		"invocation tmp parent must be disposed after the draw",
	);
});

// Auth-mode-aware requirements: env-key / proxy-provider modes carry their
// credentials outside the HOME, so the HOME files must not be demanded —
// but file-based default modes stay fail-closed.
test("prepareEphemeralHome: opencode with OPENAI_API_KEY treats HOME files as optional", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		key: process.env.OPENAI_API_KEY,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = previous.home;
		if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous.key;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";

	// Without the provider key, the HOME credential store is required.
	delete process.env.OPENAI_API_KEY;
	assert.throws(
		() => prepareEphemeralHome("opencode", tmp),
		/required auth source is missing/,
	);

	// With the key, an empty HOME is fine (env-based auth) …
	process.env.OPENAI_API_KEY = "sk-test";
	const home = prepareEphemeralHome("opencode", tmp);
	assert.ok(home, "ephemeral HOME must still be created");

	// … and an existing config file is staged as a copy.
	mkdirSync(path.join(fakeHome, ".config", "opencode"), { recursive: true });
	writeFileSync(
		path.join(fakeHome, ".config", "opencode", "opencode.json"),
		"{}",
	);
	const tmp2 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp2, { recursive: true, force: true }));
	const home2 = prepareEphemeralHome("opencode", tmp2);
	assert.ok(home2);
	assert.ok(
		existsSync(path.join(home2, ".config", "opencode", "opencode.json")),
		"present optional config must be staged into the ephemeral HOME",
	);
});

test("runCodex ephemeral HOME: opencode accepts explicitly passed provider API keys", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const envDump = path.join(tmp, "opencode-env.json");
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		bin: process.env.OPENCODE_BIN,
		allowOpenCode: process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER,
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		retry: process.env.NEEDLEFISH_NO_RETRY,
		home: process.env.HOME,
		userProfile: process.env.USERPROFILE,
		passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
		openAiKey: process.env.OPENAI_API_KEY,
		anthropicKey: process.env.ANTHROPIC_API_KEY,
		mistralKey: process.env.MISTRAL_API_KEY,
		baseUrl: process.env.OPENAI_BASE_URL,
	};
	t.after(() => {
		for (const [name, value] of Object.entries({
			OPENCODE_BIN: previous.bin,
			NEEDLEFISH_ALLOW_OPENCODE_RUNNER: previous.allowOpenCode,
			NEEDLEFISH_EPHEMERAL_HOME: previous.ephemeral,
			NEEDLEFISH_NO_RETRY: previous.retry,
			HOME: previous.home,
			USERPROFILE: previous.userProfile,
			NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: previous.passthrough,
			OPENAI_API_KEY: previous.openAiKey,
			ANTHROPIC_API_KEY: previous.anthropicKey,
			MISTRAL_API_KEY: previous.mistralKey,
			OPENAI_BASE_URL: previous.baseUrl,
		})) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({ home: process.env.HOME, userProfile: process.env.USERPROFILE, key: process.env.ANTHROPIC_API_KEY ?? process.env.MISTRAL_API_KEY }));`,
			"process.stdout.write(JSON.stringify({ type: 'text', part: { text: '{\"ok\":true}' } }) + '\\n');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = "1";
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.HOME = fakeHome;
	delete process.env.USERPROFILE;
	delete process.env.OPENAI_API_KEY;
	process.env.ANTHROPIC_API_KEY = "sk-ant-test";
	process.env.MISTRAL_API_KEY = "sk-mistral-test";

	// Undeclared and declared-but-empty API keys must not disable the
	// file-auth guard. Configuration variables are not credentials either.
	delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
	assert.throws(
		() => prepareEphemeralHome("opencode", path.join(tmp, "undeclared")),
		/required auth source is missing/,
	);
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "MISTRAL_API_KEY";
	process.env.MISTRAL_API_KEY = "";
	assert.throws(
		() => prepareEphemeralHome("opencode", path.join(tmp, "empty")),
		/required auth source is missing/,
	);
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "OPENAI_BASE_URL";
	process.env.OPENAI_BASE_URL = "https://example.invalid";
	assert.throws(
		() => prepareEphemeralHome("opencode", path.join(tmp, "config-only")),
		/required auth source is missing/,
	);

	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "ANTHROPIC_API_KEY";
	const anthropicOutput = await runCodex("prompt", {
		repoPath: repo,
		runner: "opencode",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	assert.equal(anthropicOutput, '{"ok":true}');
	const anthropicDump = JSON.parse(readFileSync(envDump, "utf8")) as {
		home: string;
		userProfile: string;
		key: string;
	};
	assert.equal(anthropicDump.key, "sk-ant-test");
	assert.equal(anthropicDump.home, anthropicDump.userProfile);
	assert.notEqual(anthropicDump.home, fakeHome);
	assert.ok(anthropicDump.home.endsWith(`${path.sep}home`));
	assert.equal(
		existsSync(anthropicDump.home),
		false,
		"isolated HOME must be disposed",
	);

	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "MISTRAL_API_KEY";
	process.env.MISTRAL_API_KEY = "sk-mistral-test";
	const mistralOutput = await runCodex("prompt", {
		repoPath: repo,
		runner: "opencode",
		targetHeadSha: headSha(repo),
		timeoutMs: 1000,
	});
	assert.equal(mistralOutput, '{"ok":true}');
	const mistralDump = JSON.parse(readFileSync(envDump, "utf8")) as {
		home: string;
		userProfile: string;
		key: string;
	};
	assert.equal(mistralDump.key, "sk-mistral-test");
	assert.equal(mistralDump.home, mistralDump.userProfile);
	assert.notEqual(mistralDump.home, fakeHome);
	assert.ok(mistralDump.home.endsWith(`${path.sep}home`));
	assert.equal(existsSync(mistralDump.home), false, "isolated HOME must be disposed");
});

test("runCodex ephemeral HOME: opencode stages custom XDG auth roots into disposable roots", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "opencode-bin.js");
	const envDump = path.join(tmp, "opencode-xdg.json");
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const configRoot = mkdtempSync(path.join(os.tmpdir(), "needlefish-xdg-config-"));
	const dataRoot = mkdtempSync(path.join(os.tmpdir(), "needlefish-xdg-data-"));
	const previous = Object.fromEntries(
		[
			"OPENCODE_BIN",
			"NEEDLEFISH_ALLOW_OPENCODE_RUNNER",
			"NEEDLEFISH_EPHEMERAL_HOME",
			"NEEDLEFISH_NO_RETRY",
			"HOME",
			"USERPROFILE",
			"XDG_CONFIG_HOME",
			"XDG_DATA_HOME",
			"OPENAI_API_KEY",
			"NEEDLEFISH_RUNNER_ENV_PASSTHROUGH",
		].map((name) => [name, process.env[name]]),
	);
	t.after(() => {
		for (const [name, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		for (const dir of [tmp, fakeHome, configRoot, dataRoot])
			rmSync(dir, { recursive: true, force: true });
	});
	mkdirSync(path.join(configRoot, "opencode"), { recursive: true });
	mkdirSync(path.join(dataRoot, "opencode"), { recursive: true });
	writeFileSync(path.join(configRoot, "opencode", "opencode.json"), '{"config":true}');
	writeFileSync(path.join(dataRoot, "opencode", "auth.json"), '{"token":"xdg"}');
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const path = require('node:path');",
			`fs.writeFileSync(${JSON.stringify(envDump)}, JSON.stringify({ home: process.env.HOME, config: process.env.XDG_CONFIG_HOME, data: process.env.XDG_DATA_HOME, auth: fs.readFileSync(path.join(process.env.XDG_DATA_HOME, 'opencode', 'auth.json'), 'utf8') }));`,
			"process.stdout.write(JSON.stringify({ type: 'text', part: { text: '{\"ok\":true}' } }) + '\\n');",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.OPENCODE_BIN = bin;
	process.env.NEEDLEFISH_ALLOW_OPENCODE_RUNNER = "1";
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.HOME = fakeHome;
	process.env.XDG_CONFIG_HOME = configRoot;
	process.env.XDG_DATA_HOME = dataRoot;
	delete process.env.USERPROFILE;
	delete process.env.OPENAI_API_KEY;
	delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;

	assert.equal(
		await runCodex("prompt", {
			repoPath: repo,
			runner: "opencode",
			targetHeadSha: headSha(repo),
			timeoutMs: 1000,
		}),
		'{"ok":true}',
	);
	const dump = JSON.parse(readFileSync(envDump, "utf8")) as {
		home: string;
		config: string;
		data: string;
		auth: string;
	};
	assert.equal(dump.config, path.join(dump.home, ".config"));
	assert.equal(dump.data, path.join(dump.home, ".local", "share"));
	assert.equal(dump.auth, '{"token":"xdg"}');
	assert.notEqual(dump.config, configRoot);
	assert.notEqual(dump.data, dataRoot);
	assert.equal(existsSync(dump.home), false, "disposable XDG roots must be removed");
});

test("prepareEphemeralHome: pi proxy provider needs models.json but not OAuth", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		provider: process.env.PI_PROVIDER,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = previous.home;
		if (previous.provider === undefined) delete process.env.PI_PROVIDER;
		else process.env.PI_PROVIDER = previous.provider;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
	writeFileSync(path.join(fakeHome, ".pi", "agent", "models.json"), "{}");
	// No auth.json planted.

	// Default provider (openai-codex OAuth) still demands auth.json.
	delete process.env.PI_PROVIDER;
	assert.throws(
		() => prepareEphemeralHome("pi", tmp),
		/required auth source is missing: .*auth\.json/,
	);

	// Explicit proxy provider: credentials live in the proxy; the registry
	// alone suffices.
	process.env.PI_PROVIDER = "cliproxy";
	const home = prepareEphemeralHome("pi", tmp);
	assert.ok(home);
	assert.ok(
		existsSync(path.join(home, ".pi", "agent", "models.json")),
		"provider registry must be staged",
	);
	assert.equal(
		existsSync(path.join(home, ".pi", "agent", "auth.json")),
		false,
		"absent OAuth file must not be fabricated",
	);

	// Proxy provider with the registry itself missing stays fail-closed.
	rmSync(path.join(fakeHome, ".pi", "agent", "models.json"));
	const tmp2 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp2, { recursive: true, force: true }));
	assert.throws(
		() => prepareEphemeralHome("pi", tmp2),
		/required auth source is missing: .*models\.json/,
	);
});

// codex passes --ignore-user-config on every invocation, so config.toml is
// staged when present but never demanded: an auth.json-only OAuth setup runs.
test("prepareEphemeralHome: codex requires auth.json but not the ignored config.toml", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = previous.home;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	mkdirSync(path.join(fakeHome, ".codex"));
	writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
	// No config.toml planted.

	const home = prepareEphemeralHome("codex", tmp);
	assert.ok(home, "auth.json-only OAuth setup must be accepted");
	assert.ok(
		existsSync(path.join(home, ".codex", "auth.json")),
		"auth.json must be staged",
	);
	assert.equal(
		existsSync(path.join(home, ".codex", "config.toml")),
		false,
		"absent config.toml must not be fabricated",
	);
});

// grok with a provider key passed through NEEDLEFISH_RUNNER_ENV_PASSTHROUGH
// never reads ~/.grok — the HOME files become optional config.
test("prepareEphemeralHome: grok provider key via passthrough makes HOME files optional", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
		key: process.env.XAI_API_KEY,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = previous.home;
		if (previous.passthrough === undefined)
			delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
		else process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = previous.passthrough;
		if (previous.key === undefined) delete process.env.XAI_API_KEY;
		else process.env.XAI_API_KEY = previous.key;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	// No ~/.grok files planted.

	// Without a provider key, grok HOME files stay required.
	delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
	delete process.env.XAI_API_KEY;
	assert.throws(
		() => prepareEphemeralHome("grok", tmp),
		/required auth source is missing/,
	);

	// Passthrough naming a set provider key → HOME files optional.
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "XAI_API_KEY";
	process.env.XAI_API_KEY = "xai-test";
	const tmp2 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp2, { recursive: true, force: true }));
	assert.ok(prepareEphemeralHome("grok", tmp2), "provider-key mode must pass");

	// Passthrough naming an UNSET key does not count as provider-key auth.
	delete process.env.XAI_API_KEY;
	const tmp3 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp3, { recursive: true, force: true }));
	assert.throws(
		() => prepareEphemeralHome("grok", tmp3),
		/required auth source is missing/,
	);

	// Non-credential GROK_*/XAI_* vars (config, endpoints) and EMPTY keys do
	// not count either — only a non-empty supported credential variable does.
	for (const [name, value] of [
		["GROK_MODEL", "grok-4.5"],
		["XAI_BASE_URL", "https://proxy.example"],
		["XAI_API_KEY", ""],
	] as const) {
		process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = name;
		process.env[name] = value;
		const tmpN = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
		t.after(() => {
			delete process.env[name];
			rmSync(tmpN, { recursive: true, force: true });
		});
		assert.throws(
			() => prepareEphemeralHome("grok", tmpN),
			/required auth source is missing/,
			`${name}=${JSON.stringify(value)} must not unlock provider-key mode`,
		);
		delete process.env[name];
	}
});

// Env-authenticated runners (provider key via passthrough) need no source
// HOME at all — CI containers legitimately run without HOME/USERPROFILE.
// Only runners that still REQUIRE auth files fail on a missing HOME.
test("prepareEphemeralHome: no HOME/USERPROFILE is fine when auth is env-borne, fatal when files are required", (t) => {
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		profile: process.env.USERPROFILE,
		passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
		key: process.env.XAI_API_KEY,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		if (previous.profile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previous.profile;
		if (previous.passthrough === undefined)
			delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
		else process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = previous.passthrough;
		if (previous.key === undefined) delete process.env.XAI_API_KEY;
		else process.env.XAI_API_KEY = previous.key;
	});
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	delete process.env.HOME;
	delete process.env.USERPROFILE;

	// grok authed via provider key: no required files → no HOME needed.
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "XAI_API_KEY";
	process.env.XAI_API_KEY = "xai-test";
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const home = prepareEphemeralHome("grok", tmp);
	assert.ok(home, "env-authenticated runner must not need a source HOME");
	assert.ok(
		home.startsWith(tmp),
		"ephemeral home must live under the run tmp dir",
	);

	// codex still requires auth files: with no HOME to copy from, fail loudly
	// (fail-closed) instead of launching an unauthenticated runner.
	delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
	delete process.env.XAI_API_KEY;
	const tmp2 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp2, { recursive: true, force: true }));
	assert.throws(
		() => prepareEphemeralHome("codex", tmp2),
		/neither HOME nor USERPROFILE/,
	);
});

// acp launches arbitrary agents with unknowable credential layouts: without
// an explicit operator-declared staging list there is nothing safe to stage,
// so it must fail closed rather than silently keep the real HOME.
test("prepareEphemeralHome: acp without a declared staging list fails closed", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		acpFiles: process.env.NEEDLEFISH_ACP_AUTH_FILES,
		authEnv: process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.acpFiles === undefined)
			delete process.env.NEEDLEFISH_ACP_AUTH_FILES;
		else process.env.NEEDLEFISH_ACP_AUTH_FILES = previous.acpFiles;
		if (previous.authEnv === undefined)
			delete process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS;
		else process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = previous.authEnv;
		rmSync(tmp, { recursive: true, force: true });
	});
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	delete process.env.NEEDLEFISH_ACP_AUTH_FILES;
	delete process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS;
	assert.throws(
		() => prepareEphemeralHome("acp", tmp),
		/NEEDLEFISH_ACP_AUTH_FILES/,
	);
});

// Environment-authenticated acp requires an explicit credential classification
// in addition to the general passthrough authorization.
test("prepareEphemeralHome: acp validates explicitly declared env credentials", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		acpFiles: process.env.NEEDLEFISH_ACP_AUTH_FILES,
		authEnv: process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS,
		passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
		token: process.env.MY_AGENT_TOKEN,
		baseUrl: process.env.OPENAI_BASE_URL,
		home: process.env.HOME,
	};
	t.after(() => {
		for (const [key, value] of [
			["NEEDLEFISH_EPHEMERAL_HOME", previous.ephemeral],
			["NEEDLEFISH_ACP_AUTH_FILES", previous.acpFiles],
			["NEEDLEFISH_ACP_AUTH_ENV_VARS", previous.authEnv],
			["NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", previous.passthrough],
			["MY_AGENT_TOKEN", previous.token],
			["OPENAI_BASE_URL", previous.baseUrl],
			["HOME", previous.home],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.HOME = fakeHome;
	delete process.env.NEEDLEFISH_ACP_AUTH_FILES;
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "OPENAI_BASE_URL";
	process.env.OPENAI_BASE_URL = "https://config-only.invalid";

	assert.throws(
		() => prepareEphemeralHome("acp", path.join(tmp, "missing")),
		/NEEDLEFISH_ACP_AUTH_ENV_VARS/,
		"general passthrough config alone must not prove authentication",
	);
	process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = " , ";
	assert.throws(
		() => prepareEphemeralHome("acp", path.join(tmp, "blank")),
		/NEEDLEFISH_ACP_AUTH_ENV_VARS/,
	);
	process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = "BAD-NAME";
	assert.throws(
		() => prepareEphemeralHome("acp", path.join(tmp, "malformed")),
		/valid environment variable names/,
	);
	process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = "MY_AGENT_TOKEN,MY_AGENT_TOKEN";
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "MY_AGENT_TOKEN";
	process.env.MY_AGENT_TOKEN = "tok";
	assert.throws(
		() => prepareEphemeralHome("acp", path.join(tmp, "duplicate")),
		/must be unique/,
	);
	process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = "MY_AGENT_TOKEN";
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "OPENAI_BASE_URL";
	assert.throws(
		() => prepareEphemeralHome("acp", path.join(tmp, "not-passed")),
		/must also appear in NEEDLEFISH_RUNNER_ENV_PASSTHROUGH/,
	);
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "MY_AGENT_TOKEN";
	process.env.MY_AGENT_TOKEN = "";
	assert.throws(
		() => prepareEphemeralHome("acp", path.join(tmp, "empty")),
		/missing or empty/,
	);

	process.env.MY_AGENT_TOKEN = "tok";
	const home = prepareEphemeralHome("acp", path.join(tmp, "valid"));
	assert.ok(home, "env-authenticated acp must keep isolation on");
});

// Empty comma-list segments are never credentials. Exercise the real runCodex
// path so a regression proves it fails before the ACP child can launch.
test("runCodex ephemeral HOME: acp rejects empty auth-list entries before launch", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "acp-bin.js");
	const launchDump = path.join(tmp, "acp-launched");
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		bin: process.env.NEEDLEFISH_ACP_BIN,
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		retry: process.env.NEEDLEFISH_NO_RETRY,
		acpFiles: process.env.NEEDLEFISH_ACP_AUTH_FILES,
		authEnv: process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS,
		passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
		baseUrl: process.env.OPENAI_BASE_URL,
		home: process.env.HOME,
	};
	t.after(() => {
		for (const [key, value] of [
			["NEEDLEFISH_ACP_BIN", previous.bin],
			["NEEDLEFISH_EPHEMERAL_HOME", previous.ephemeral],
			["NEEDLEFISH_NO_RETRY", previous.retry],
			["NEEDLEFISH_ACP_AUTH_FILES", previous.acpFiles],
			["NEEDLEFISH_ACP_AUTH_ENV_VARS", previous.authEnv],
			["NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", previous.passthrough],
			["OPENAI_BASE_URL", previous.baseUrl],
			["HOME", previous.home],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`fs.writeFileSync(${JSON.stringify(launchDump)}, "launched");`,
			"process.exit(1);",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.NEEDLEFISH_ACP_BIN = bin;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.HOME = fakeHome;
	process.env.OPENAI_BASE_URL = "https://config-only.invalid";

	const cases = [
		{ label: "file comma-only", files: ",", authEnv: "BAD-NAME" },
		{ label: "file leading comma", files: ",.agent/auth.json", authEnv: "BAD-NAME" },
		{ label: "file trailing comma", files: ".agent/auth.json,", authEnv: "BAD-NAME" },
		{
			label: "file doubled comma",
			files: ".agent/auth.json,,.agent/other.json",
			authEnv: "BAD-NAME",
		},
		{ label: "env comma-only", authEnv: "," },
		{ label: "env leading comma", authEnv: ",MY_AGENT_TOKEN" },
		{ label: "env trailing comma", authEnv: "MY_AGENT_TOKEN," },
		{
			label: "env doubled comma",
			authEnv: "MY_AGENT_TOKEN,,OTHER_TOKEN",
		},
	] as const;

	for (const scenario of cases) {
		if ("files" in scenario)
			process.env.NEEDLEFISH_ACP_AUTH_FILES = scenario.files;
		else delete process.env.NEEDLEFISH_ACP_AUTH_FILES;
		process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = scenario.authEnv;
		process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "OPENAI_BASE_URL";

		await assert.rejects(
			() =>
				runCodex("prompt", {
					repoPath: repo,
					runner: "acp",
					targetHeadSha: headSha(repo),
					timeoutMs: 1000,
				}),
			/entries must not be empty/,
			scenario.label,
		);
		assert.equal(
			existsSync(launchDump),
			false,
			`${scenario.label} must fail before child launch`,
		);
	}
});

// With a declared list, acp stages exactly those files (copy-only) into the
// isolated HOME — the supported eval path keeps its anti-cheat generation.
test("prepareEphemeralHome: acp stages operator-declared credentials", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		acpFiles: process.env.NEEDLEFISH_ACP_AUTH_FILES,
		authEnv: process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS,
		home: process.env.HOME,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.acpFiles === undefined)
			delete process.env.NEEDLEFISH_ACP_AUTH_FILES;
		else process.env.NEEDLEFISH_ACP_AUTH_FILES = previous.acpFiles;
		if (previous.authEnv === undefined)
			delete process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS;
		else process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = previous.authEnv;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	mkdirSync(path.join(fakeHome, ".myagent"));
	writeFileSync(path.join(fakeHome, ".myagent", "cred.json"), '{"k":"v"}');
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_ACP_AUTH_FILES = ".myagent/cred.json";
	process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = "BAD-NAME";

	const home = prepareEphemeralHome("acp", tmp);
	assert.ok(home, "isolation must stay on for a declared acp staging list");
	assert.equal(
		readFileSync(path.join(home!, ".myagent", "cred.json"), "utf8"),
		'{"k":"v"}',
	);
	// Copy, not symlink.
	assert.equal(
		lstatSync(path.join(home!, ".myagent", "cred.json")).isSymbolicLink(),
		false,
	);

	// A declared file that does not exist keeps the fail-closed contract.
	process.env.NEEDLEFISH_ACP_AUTH_FILES = ".myagent/missing.json";
	assert.throws(
		() => prepareEphemeralHome("acp", tmp),
		/required auth source is missing/,
	);

	// Traversal and absolute entries are rejected outright — in BOTH separator
	// forms: on Windows `..\` traverses and `C:\` is absolute, and staging
	// resolves paths platform-natively.
	for (const bad of [
		"../escape.json",
		"/etc/passwd",
		"..\\secret.json",
		"C:\\secret.json",
		"nested/..\\..\\secret.json",
	]) {
		process.env.NEEDLEFISH_ACP_AUTH_FILES = bad;
		assert.throws(
			() => prepareEphemeralHome("acp", tmp),
			/HOME-relative without/,
			`entry must be rejected: ${bad}`,
		);
	}
});

// Windows parity: buildRunnerEnv overrides both HOME and USERPROFILE, so the
// auth source root accepts either — HOME unset + USERPROFILE set must work.
test("prepareEphemeralHome resolves auth sources from USERPROFILE when HOME is unset", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		profile: process.env.USERPROFILE,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		if (previous.profile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previous.profile;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	mkdirSync(path.join(fakeHome, ".codex"));
	writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	delete process.env.HOME;
	process.env.USERPROFILE = fakeHome;

	const home = prepareEphemeralHome("codex", tmp);
	assert.ok(home, "USERPROFILE-only environment must be accepted");
	assert.ok(
		existsSync(path.join(home, ".codex", "auth.json")),
		"auth must be staged from the USERPROFILE root",
	);

	// Neither set → fail closed.
	delete process.env.USERPROFILE;
	const tmp2 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp2, { recursive: true, force: true }));
	assert.throws(
		() => prepareEphemeralHome("codex", tmp2),
		/neither HOME nor USERPROFILE/,
	);
});

// codex analog of the grok provider-key mode: a non-empty CODEX_API_KEY in
// the passthrough authenticates without auth.json.
test("prepareEphemeralHome: codex API key via passthrough makes HOME files optional", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
		key: process.env.CODEX_API_KEY,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		process.env.HOME = previous.home;
		if (previous.passthrough === undefined)
			delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
		else process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = previous.passthrough;
		if (previous.key === undefined) delete process.env.CODEX_API_KEY;
		else process.env.CODEX_API_KEY = previous.key;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	process.env.HOME = fakeHome;
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	// No ~/.codex files planted.

	// Key set and named in passthrough → empty HOME accepted.
	process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "CODEX_API_KEY";
	process.env.CODEX_API_KEY = "ck-test";
	assert.ok(prepareEphemeralHome("codex", tmp), "API-key mode must pass");

	// Empty key → back to fail-closed file requirement.
	process.env.CODEX_API_KEY = "";
	const tmp2 = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	t.after(() => rmSync(tmp2, { recursive: true, force: true }));
	assert.throws(
		() => prepareEphemeralHome("codex", tmp2),
		/required auth source is missing: .*auth\.json/,
	);
});

// HOME="" (sanitized environments) must fall through to USERPROFILE, not be
// selected as an empty path root.
test("prepareEphemeralHome falls back to USERPROFILE when HOME is empty", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
	const previous = {
		ephemeral: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		home: process.env.HOME,
		profile: process.env.USERPROFILE,
	};
	t.after(() => {
		if (previous.ephemeral === undefined)
			delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.ephemeral;
		if (previous.home === undefined) delete process.env.HOME;
		else process.env.HOME = previous.home;
		if (previous.profile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = previous.profile;
		rmSync(tmp, { recursive: true, force: true });
		rmSync(fakeHome, { recursive: true, force: true });
	});
	mkdirSync(path.join(fakeHome, ".codex"));
	writeFileSync(path.join(fakeHome, ".codex", "auth.json"), '{"token":"x"}');
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.HOME = "";
	process.env.USERPROFILE = fakeHome;

	const home = prepareEphemeralHome("codex", tmp);
	assert.ok(home, "empty HOME must fall through to USERPROFILE");
	assert.ok(
		existsSync(path.join(home, ".codex", "auth.json")),
		"auth must be staged from the USERPROFILE root",
	);
});
