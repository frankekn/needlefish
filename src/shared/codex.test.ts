import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractJson, runCodex } from "./codex";
import { headSha, initRepo } from "./codex-runner-test-fixtures";

test("extractJson parses fenced JSON output", () => {
  const text = "preface\n```json\n{\"ok\":true}\n```\ntrailer";

  const parsed = extractJson(text);

  assert.deepEqual(parsed, { ok: true });
});

test("extractJson rejects output without a JSON object", () => {
  const text = "no object here";

  assert.throws(() => extractJson(text), /no JSON object found/);
});

test("runCodex retry backoff yields the event loop", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const state = path.join(tmp, "state");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `const state = ${JSON.stringify(state)};`,
      "if (!fs.existsSync(state)) {",
      "  fs.writeFileSync(state, 'failed');",
      "  process.stderr.write('first failure');",
      "  process.exit(1);",
      "}",
      "fs.writeFileSync(out, '{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "50";

  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);

  const output = await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output, "{\"ok\":true}");
  assert.equal(timerFired, true);
});

test("runCodex kills a runner that ignores SIGTERM on timeout", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const childPidPath = path.join(tmp, "child.pid");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
    noRetry: process.env.NEEDLEFISH_NO_RETRY,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    if (previous.noRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
    else process.env.NEEDLEFISH_NO_RETRY = previous.noRetry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const childPidPath = ${JSON.stringify(childPidPath)};`,
      "fs.writeFileSync(childPidPath, String(process.pid));",
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
      "fs.writeFileSync(childPidPath, String(child.pid));",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "1";
  process.env.NEEDLEFISH_NO_RETRY = "1";

  const startedAt = Date.now();

  await assert.rejects(
    () =>
      runCodex("prompt", {
        repoPath: repo,
        runner: "codex",
        targetHeadSha: headSha(repo),
        timeoutMs: 2000,
      }),
    /ETIMEDOUT/
  );
  assert.ok(Date.now() - startedAt < 5000);
  const childPid = Number(readFileSync(childPidPath, "utf8"));
  assert.equal(await processExited(childPid, 5000), true);
});

test("runCodex passes allowlisted env vars to the runner subprocess", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const envDump = path.join(tmp, "env-dump.json");
  const previous = {
    bin: process.env.CODEX_BIN,
    model: process.env.CODEX_MODEL,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.model === undefined) delete process.env.CODEX_MODEL;
    else process.env.CODEX_MODEL = previous.model;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `const envDump = ${JSON.stringify(envDump)};`,
      "fs.writeFileSync(envDump, JSON.stringify({ codexModel: process.env.CODEX_MODEL ?? null }));",
      "fs.writeFileSync(out, '{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_MODEL = "test-model";

  await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  const dump = JSON.parse(readFileSync(envDump, "utf8")) as { codexModel: string | null };
  assert.equal(dump.codexModel, "test-model");
});

test("runCodex strips non-allowlisted env vars from the runner subprocess", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const envDump = path.join(tmp, "env-dump.json");
  const previous = {
    bin: process.env.CODEX_BIN,
    secret: process.env.NEEDLEFISH_TEST_FAKE_SECRET,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.secret === undefined) delete process.env.NEEDLEFISH_TEST_FAKE_SECRET;
    else process.env.NEEDLEFISH_TEST_FAKE_SECRET = previous.secret;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `const envDump = ${JSON.stringify(envDump)};`,
      "fs.writeFileSync(envDump, JSON.stringify({ secret: process.env.NEEDLEFISH_TEST_FAKE_SECRET ?? null }));",
      "fs.writeFileSync(out, '{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_TEST_FAKE_SECRET = "should-not-leak";

  await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  const dump = JSON.parse(readFileSync(envDump, "utf8")) as { secret: string | null };
  assert.equal(dump.secret, null);
});

test("runCodex passes NEEDLEFISH_RUNNER_ENV_PASSTHROUGH vars through", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const envDump = path.join(tmp, "env-dump.json");
  const previous = {
    bin: process.env.CODEX_BIN,
    secret: process.env.NEEDLEFISH_TEST_FAKE_SECRET,
    passthrough: process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.secret === undefined) delete process.env.NEEDLEFISH_TEST_FAKE_SECRET;
    else process.env.NEEDLEFISH_TEST_FAKE_SECRET = previous.secret;
    if (previous.passthrough === undefined) delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
    else process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = previous.passthrough;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `const envDump = ${JSON.stringify(envDump)};`,
      "fs.writeFileSync(envDump, JSON.stringify({ secret: process.env.NEEDLEFISH_TEST_FAKE_SECRET ?? null }));",
      "fs.writeFileSync(out, '{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_TEST_FAKE_SECRET = "should-leak-now";
  process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "NEEDLEFISH_TEST_FAKE_SECRET";

  await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  const dump = JSON.parse(readFileSync(envDump, "utf8")) as { secret: string | null };
  assert.equal(dump.secret, "should-leak-now");
});

test("runCodex passes claude auth env vars to the claude runner subprocess", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
  const envDump = path.join(tmp, "env-dump.json");
  const previous = {
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
    apiKey: process.env.ANTHROPIC_API_KEY,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    if (previous.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previous.apiKey;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.readFileSync(0, 'utf8');",
      `const envDump = ${JSON.stringify(envDump)};`,
      "fs.writeFileSync(envDump, JSON.stringify({ apiKey: process.env.ANTHROPIC_API_KEY ?? null }));",
      "process.stdout.write('{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.ANTHROPIC_API_KEY = "test-key";

  await runCodex("prompt", {
    repoPath: repo,
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  const dump = JSON.parse(readFileSync(envDump, "utf8")) as { apiKey: string | null };
  assert.equal(dump.apiKey, "test-key");
});

async function processExited(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return !processExists(pid);
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

test("openai runner failures ride the full response body for the canary scan", async (t) => {
	const { createServer } = await import("node:http");
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const previous = {
		base: process.env.OPENAI_BASE_URL,
		key: process.env.OPENAI_API_KEY,
		retry: process.env.CODEX_RETRY_MS,
	};
	// Attempt 1: HTTP 500 whose body parks the canary PAST the 2000-char clip
	// the error message applies. Attempt 2 (retry): HTTP 200 with a non-JSON
	// body — the parse-failure path. Both bodies must reach onFailedRaw whole;
	// the direct-HTTP runner has no stdout/out-file surfaces to fall back on.
	let calls = 0;
	const server = createServer((_req, res) => {
		calls += 1;
		if (calls === 1) {
			res.statusCode = 500;
			res.end(`${"x".repeat(2500)} CANARY-HTTP-500`);
			return;
		}
		res.statusCode = 200;
		res.end("not json at all CANARY-HTTP-BODY");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("test server did not bind a port");
	t.after(() => {
		server.close();
		if (previous.base === undefined) delete process.env.OPENAI_BASE_URL;
		else process.env.OPENAI_BASE_URL = previous.base;
		if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = previous.key;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	process.env.OPENAI_BASE_URL = `http://127.0.0.1:${address.port}`;
	process.env.OPENAI_API_KEY = "test-key";
	process.env.CODEX_RETRY_MS = "1";

	const failedRaws: string[] = [];
	const rejection = await runCodex("prompt", {
		repoPath: repo,
		runner: "openai",
		model: "test-model",
		targetHeadSha: headSha(repo),
		timeoutMs: 5000,
		onFailedRaw: (raw) => failedRaws.push(raw),
	}).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error, "both attempts failing must reject");
	assert.match(rejection.message, /non-JSON response body/);
	assert.equal(calls, 2, "the runner must have retried once");
	assert.ok(
		failedRaws.some((raw) => raw.includes("CANARY-HTTP-500")),
		"the HTTP-error body past the message clip must reach the scan",
	);
	assert.ok(
		failedRaws.some((raw) => raw.includes("CANARY-HTTP-BODY")),
		"the non-JSON 200 body must reach the scan",
	);
});

test("onFailedRaw fires once per failed attempt", async (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
	const repo = initRepo(tmp);
	const bin = path.join(tmp, "codex-bin.js");
	const previous = {
		bin: process.env.CODEX_BIN,
		retry: process.env.CODEX_RETRY_MS,
	};
	t.after(() => {
		if (previous.bin === undefined) delete process.env.CODEX_BIN;
		else process.env.CODEX_BIN = previous.bin;
		if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
		else process.env.CODEX_RETRY_MS = previous.retry;
		rmSync(tmp, { recursive: true, force: true });
	});
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"process.stdin.resume();",
			"process.stdin.on('end', () => {",
			"  process.stdout.write('crash output');",
			"  process.exit(3);",
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";

	// The rider itself still carries the last attempt's output (it rides the
	// error object, not an accumulator) — but the caller-side accumulator is
	// the review layer's, and review gates retention on evalTraceOn(). Here we
	// assert the plumbing contract: onFailedRaw still fires; what the caller
	// DOES with it is the trace-gated part (covered in review.test.ts).
	const failedRaws: string[] = [];
	const rejection = await runCodex("prompt", {
		repoPath: repo,
		runner: "codex",
		targetHeadSha: headSha(repo),
		timeoutMs: 5000,
		onFailedRaw: (raw) => failedRaws.push(raw),
	}).then(
		() => null,
		(err: unknown) => err,
	);
	assert.ok(rejection instanceof Error);
	assert.equal(failedRaws.length, 2, "one capture per failed attempt");
});
