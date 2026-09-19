import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runAcp } from "./acp.js";
import { runCodex, RunnerOperationalError } from "./codex.js";
import { headSha, initRepo } from "./codex-runner-test-fixtures.js";
import { findRunnerFailure, type RunnerFailureKind } from "./runner-failure.js";
import type { RunStat } from "./runner.js";

const PRIVATE = "startup-private-token-canary";

for (const mode of ["silent", "stderr", "partial", "noise", "late-initialize", "stubborn"]) {
  test(`ACP initialize ${mode} expires without retry or sending the review prompt`, { timeout: 15_000 }, async (t) => {
    const f = fixture(t, mode);
    const error = await failed(f, "startup_timeout");
    assert.match(error.message, /ACP initialize failed: initialize timeout/);
    assert.ok(f.requests().every((request) => request.method === "initialize"));
    if (mode === "silent") assert.match(error.message, /stdout=0B; stderr=0B/);
    if (mode === "stderr") assert.match(f.raw.join("\n"), /startup-private-token-canary/);
  });
}

for (const mode of ["exit0", "exit7", "auth", "malformed", "wrong-id", "wrong-version", "missing-version", "wrong-jsonrpc"]) {
  test(`ACP initialize ${mode} is a non-retryable startup failure with safe diagnostics`, async (t) => {
    const f = fixture(t, mode);
    const error = await failed(f, "startup_failed");
    assert.match(error.message, /ACP initialize failed:/);
    assert.ok(!f.requests().some((request) => request.method === "session/prompt"));
    if (mode === "exit7") assert.match(error.message, /exit=7/);
    if (mode === "auth") assert.match(error.message, /authentication required/);
    assert.match(f.raw.join("\n"), /startup-private-token-canary/);
  });
}

for (const mode of ["session-exit", "session-hang"]) {
  test(`ACP ${mode} reports session/new, not initialize or review`, async (t) => {
    const f = fixture(t, mode, 1300);
    const error = await failed(f, mode === "session-hang" ? "startup_timeout" : "startup_failed");
    assert.match(error.message, /ACP session\/new failed:/);
    assert.deepEqual(f.requests().map((request) => request.method), ["initialize", "session/new"]);
  });
}

test("valid initialize clears its timer; a longer review still succeeds", async (t) => {
  const f = fixture(t, "slow-review");
  const stats: RunStat[] = [];
  const output = await runCodex("private review prompt", { ...f.options, onStat: (stat) => stats.push(stat) });
  assert.equal(output, '{"ok":true}');
  assert.equal(stats[0].ok, true);
  assert.equal(stats[0].attempts, 1);
  assertDisposed(f);
});

test("session/prompt timeout remains a review timeout and preserves bounded retry", async (t) => {
  const f = fixture(t, "prompt-hang", 1300);
  const error = await failed(f, "unknown", 2);
  assert.match(error.message, /ACP session\/prompt review timeout \(ETIMEDOUT\)/);
  assert.equal(findRunnerFailure(error)?.retryable, true);
  assert.equal(f.requests().filter((request) => request.method === "session/cancel").length, 2);
});

test("remaining call budget wins over a longer initialize budget", async (t) => {
  const f = fixture(t, "silent");
  process.env.NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS = "5000";
  const started = performance.now();
  const result = await runAcp({ prompt: "not sent", repoPath: f.options.repoPath, env: process.env, timeoutMs: 300 });
  assert.equal(findRunnerFailure(result.res.error)?.kind, "startup_timeout");
  assert.match(result.res.error?.message ?? "", /ACP initialize/);
  assert.ok(performance.now() - started < 3000, "must not wait for the configured 5s handshake allowance");
});

for (const value of ["0", "-1", "1.5", "Infinity", "2147483648", PRIVATE]) {
  test(`invalid initialize timeout ${value} fails before spawn without echoing input`, async (t) => {
    const f = fixture(t, "silent");
    process.env.NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS = value;
    await assert.rejects(runCodex("prompt", f.options), (error: unknown) => {
      assert.ok(error instanceof RunnerOperationalError);
      assert.equal(findRunnerFailure(error)?.kind, "startup_failed");
      assert.doesNotMatch(error.message, /startup-private-token-canary/);
      return true;
    });
    assert.deepEqual(f.launches(), []);
  });
}

for (const missing of [true, false]) {
  test(`ACP launcher ${missing ? "unset" : "not found"} is not retried`, async (t) => {
    const f = fixture(t, "silent");
    if (missing) delete process.env.NEEDLEFISH_ACP_BIN;
    else process.env.NEEDLEFISH_ACP_BIN = path.join(f.root, "missing-agent");
    const stats: RunStat[] = [];
    await assert.rejects(runCodex("prompt", { ...f.options, onStat: (stat) => stats.push(stat) }), (error: unknown) => {
      assert.ok(error instanceof RunnerOperationalError);
      assert.equal(findRunnerFailure(error)?.kind, "startup_failed");
      assert.match(error.message, missing ? /NEEDLEFISH_ACP_BIN is required/ : /ENOENT/);
      return true;
    });
    assert.equal(stats[0].attempts, 1);
    assert.deepEqual(f.launches(), []);
  });
}

async function failed(f: ReturnType<typeof fixture>, kind: RunnerFailureKind, attempts = 1): Promise<Error> {
  let caught: Error | undefined;
  const stats: RunStat[] = [];
  const successes: string[] = [];
  await assert.rejects(runCodex("private review prompt", {
    ...f.options, onStat: (stat) => stats.push(stat),
    onRaw: (raw) => successes.push(raw), onFailedRaw: (raw) => f.raw.push(raw),
  }), (error: unknown) => {
    assert.ok(error instanceof RunnerOperationalError);
    assert.equal(findRunnerFailure(error)?.kind, kind);
    assert.doesNotMatch(error.message, /startup-private-token-canary|private review prompt|no JSON object found/);
    assert.doesNotMatch(JSON.stringify(error), /startup-private-token-canary/);
    caught = error;
    return true;
  });
  assert.equal(stats.length, 1);
  assert.equal(stats[0].ok, false);
  assert.equal(stats[0].attempts, attempts);
  assert.equal(f.launches().length, attempts);
  assert.deepEqual(successes, []);
  assertDisposed(f);
  assert.ok(caught);
  return caught;
}

function assertDisposed(f: ReturnType<typeof fixture>): void {
  for (const launch of f.launches()) {
    assert.equal(existsSync(launch.cwd), false, "disposable clone must be removed");
    assert.equal(existsSync(launch.home), false, "disposable HOME must be removed");
    assert.throws(() => process.kill(launch.pid, 0), { code: "ESRCH" });
  }
  assert.equal(headSha(f.options.repoPath), f.options.targetHeadSha);
}

function fixture(t: TestContext, mode: string, timeoutMs = 5000) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-acp-startup-"));
  const repo = initRepo(root);
  const bin = path.join(root, "agent.cjs");
  const requests = path.join(root, "requests.ndjson");
  const launches = path.join(root, "launches.ndjson");
  const home = path.join(root, "home");
  mkdirSync(home);
  const env: Record<string, string | undefined> = {
    NEEDLEFISH_ACP_BIN: bin, NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS: "750",
    NEEDLEFISH_NO_RETRY: "0", NEEDLEFISH_RETRY_MS: "1", NEEDLEFISH_EPHEMERAL_HOME: "1",
    NEEDLEFISH_ACP_AUTH_FILES: "", NEEDLEFISH_ACP_AUTH_ENV_VARS: "TEST_ACP_TOKEN",
    NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "TEST_ACP_TOKEN", TEST_ACP_TOKEN: "fake-auth",
    HOME: home, USERPROFILE: home, NEEDLEFISH_REVIEW_TIMEOUT_MS: undefined,
    NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS: "25", NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "250",
    NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS: "100",
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  writeFileSync(bin, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const mode = ${JSON.stringify(mode)};
const requests = ${JSON.stringify(requests)};
const launches = ${JSON.stringify(launches)};
fs.appendFileSync(launches, JSON.stringify({pid:process.pid,cwd:process.cwd(),home:process.env.HOME})+'\n');
const send = (message) => process.stdout.write(JSON.stringify(message)+'\n');
let initializeId;
if (mode === 'late-initialize' || mode === 'stubborn') process.on('SIGTERM', () => {
  if (mode === 'late-initialize') send({jsonrpc:'2.0',id:initializeId,result:{protocolVersion:1}});
});
readline.createInterface({input:process.stdin}).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(requests, JSON.stringify(request)+'\n');
  if (request.method === 'initialize') {
    initializeId = request.id;
    if (['silent','late-initialize','stubborn'].includes(mode)) return;
    if (mode === 'stderr') { setInterval(() => process.stderr.write(${JSON.stringify(PRIVATE)}+'\n'), 20); return; }
    if (mode === 'partial') { process.stdout.write('{"jsonrpc":'); return; }
    if (mode === 'noise') { setInterval(() => send({jsonrpc:'2.0',method:'agent/status',params:{}}),20); return; }
    if (['exit0','exit7','auth','malformed','wrong-id','wrong-version','missing-version','wrong-jsonrpc'].includes(mode)) fs.writeSync(2, ${JSON.stringify(PRIVATE)}+'\n');
    if (mode === 'exit0' || mode === 'exit7') process.exit(mode === 'exit7' ? 7 : 0);
    if (mode === 'auth') { send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:${JSON.stringify(PRIVATE)}}}); return; }
    if (mode === 'malformed') { process.stdout.write(${JSON.stringify(PRIVATE)}+'\n'); return; }
    send({jsonrpc: mode === 'wrong-jsonrpc' ? '1.0' : '2.0',id:mode === 'wrong-id' ? 99 : request.id,result:mode === 'missing-version' ? {} : {protocolVersion:mode === 'wrong-version' ? 2 : 1}});
  } else if (request.method === 'session/new') {
    if (mode === 'session-exit') process.exit(7);
    if (mode === 'session-hang') return;
    send({jsonrpc:'2.0',id:request.id,result:{sessionId:'s'}});
  } else if (request.method === 'session/prompt') {
    if (mode === 'prompt-hang') return;
    setTimeout(() => {
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'{"ok":true}'}}}});
      send({jsonrpc:'2.0',id:request.id,result:{stopReason:'end_turn'}});
    }, mode === 'slow-review' ? 1200 : 0);
  }
});
`);
  chmodSync(bin, 0o755);
  const lines = (file: string): string[] => existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean) : [];
  return {
    root, raw: [] as string[],
    options: { repoPath: repo, targetHeadSha: headSha(repo), runner: "acp" as const, timeoutMs },
    requests: () => lines(requests).map((line): { method?: string } => JSON.parse(line)),
    launches: () => lines(launches).map((line): { pid: number; cwd: string; home: string } => JSON.parse(line)),
  };
}
