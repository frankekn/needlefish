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
