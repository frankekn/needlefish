import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCodex, RunnerOperationalError } from "./codex.js";
import { headSha, initRepo } from "./codex-runner-test-fixtures.js";
import { findRunnerFailure, type RunnerFailureKind } from "./runner-failure.js";
import type { RunStat } from "./runner.js";

const PRIVATE_TEXT = "private-token-and-prompt-canary";
interface Scenario {
  readonly result?: unknown;
  readonly error?: unknown;
  readonly malformed?: boolean;
  readonly permission?: boolean;
  readonly lateSuccess?: boolean;
  readonly stubborn?: boolean;
  readonly recover?: boolean;
}

for (const [reason, kind] of [
  ["cancelled", "cancelled"],
  ["refusal", "refused"],
  ["max_tokens", "response_limit"],
  ["max_turn_requests", "response_limit"],
] as const) {
  test(`ACP ${reason} rejects even valid JSON and is not retried`, async (t) => {
    const fixture = failureFixture(t, { result: { stopReason: reason } });
    await assertFailure(fixture, kind);
    assert.equal(fixture.launches().length, 1);
  });
}

for (const result of [{}, null, { stopReason: PRIVATE_TEXT }, { stopReason: 1 }, { stopReason: "__proto__" }]) {
  test(`ACP rejects missing or invalid stopReason: ${JSON.stringify(result)}`, async (t) => {
    const fixture = failureFixture(t, { result });
    await assertFailure(fixture, "protocol_error");
    assert.equal(fixture.launches().length, 1);
  });
}

test("ACP auth-required classification comes from the code, not error text", async (t) => {
  const fixture = failureFixture(t, {
    error: { code: -32000, message: `${PRIVATE_TEXT}: quota exceeded`, data: { token: PRIVATE_TEXT } },
  });
  await assertFailure(fixture, "auth_required");
  assert.equal(fixture.launches().length, 1);
});

test("ACP structured request cancellation is not retried", async (t) => {
  const fixture = failureFixture(t, { error: { code: -32800, message: PRIVATE_TEXT } });
  await assertFailure(fixture, "cancelled");
  assert.equal(fixture.launches().length, 1);
});

for (const code of [-32700, -32600, -32601, -32602]) {
  test(`ACP protocol error ${code} is actionable without raw agent text`, async (t) => {
    const fixture = failureFixture(t, { error: { code, message: PRIVATE_TEXT } });
    await assertFailure(fixture, "protocol_error");
    assert.equal(fixture.launches().length, 1);
  });
}

for (const error of [
  PRIVATE_TEXT, null, { code: "-32000", message: PRIVATE_TEXT },
  { code: -32000 }, { code: 1.5, message: PRIVATE_TEXT },
  { code: 2147483648, message: PRIVATE_TEXT },
]) {
  test(`ACP malformed error payload is not treated as auth or quota: ${JSON.stringify(error)}`, async (t) => {
    const fixture = failureFixture(t, { error });
    await assertFailure(fixture, "protocol_error");
  });
}

test("ACP unknown errors keep bounded retries and never infer quota from prose", async (t) => {
  const fixture = failureFixture(t, {
    error: { code: 429, message: `quota exceeded ${PRIVATE_TEXT}`, data: { kind: "quota_exhausted" } },
  });
  await assertFailure(fixture, "unknown", 2);
  assert.equal(fixture.launches().length, 2);
});

test("ACP unknown transient error can still recover on the existing second attempt", async (t) => {
  const fixture = failureFixture(t, {
    error: { code: -32603, message: PRIVATE_TEXT }, recover: true,
  });
  const failed: string[] = [];
  const successful: string[] = [];
  const stats: RunStat[] = [];
  const out = await runCodex("prompt", {
    ...fixture.options, onFailedRaw: (raw) => failed.push(raw),
    onRaw: (raw) => successful.push(raw), onStat: (stat) => stats.push(stat),
  });
  assert.equal(out, '{"ok":true}');
  assert.equal(failed.length, 1);
  assert.match(failed[0], /private-token-and-prompt-canary/);
  assert.equal(successful.length, 1);
  assert.equal(stats[0].attempts, 2);
  assert.equal(stats[0].ok, true);
  assertDisposed(fixture);
});

test("ACP malformed stdout is withheld publicly but retained in failed raw callback", async (t) => {
  const fixture = failureFixture(t, { malformed: true });
  await assertFailure(fixture, "protocol_error");
});

for (const lateSuccess of [false, true]) {
  test(`ACP cancels all pending permissions; late success=${lateSuccess} cannot clear failure`, async (t) => {
    const fixture = failureFixture(t, { permission: true, lateSuccess });
    await assertFailure(fixture, "permission_required");
    const messages = fixture.transcript();
    for (const id of ["permission-a", "permission-b"]) {
      assert.ok(messages.some((message) => message.id === id &&
        JSON.stringify(message.result) === '{"outcome":{"outcome":"cancelled"}}'));
    }
    assert.equal(messages.filter((message) => message.method === "session/cancel").length, 1);
    assert.equal(fixture.launches().length, 1);
  });
}

test("ACP permission cancellation kills a SIGTERM-trapping agent without retry", { timeout: 10_000 }, async (t) => {
  const fixture = failureFixture(t, { permission: true, stubborn: true, lateSuccess: true });
  await assertFailure(fixture, "permission_required");
  const launch = fixture.launches()[0];
  assert.equal(typeof launch.pid, "number");
  assert.throws(() => process.kill(launch.pid as number, 0), { code: "ESRCH" });
  assertDisposed(fixture);
});

test("ACP normal end_turn keeps the original successful text and callbacks", async (t) => {
  const fixture = failureFixture(t, { result: { stopReason: "end_turn" } });
  const failed: string[] = [];
  const stats: RunStat[] = [];
  const out = await runCodex("prompt", {
    ...fixture.options, onFailedRaw: (raw) => failed.push(raw), onStat: (stat) => stats.push(stat),
  });
  assert.equal(out, '{"ok":true}');
  assert.deepEqual(failed, []);
  assert.equal(stats[0].ok, true);
  assert.equal(stats[0].attempts, 1);
  assert.equal(stats[0].usage, undefined);
  assertDisposed(fixture);
});

// Completion decides success; usage is optional telemetry, never permission
// to accept an interrupted turn. Reuse the existing real-process fixture.
const USAGE = { totalTokens: 30, inputTokens: 20, outputTokens: 10 };
for (const [reason, kind] of [
  ["cancelled", "cancelled"], ["refusal", "refused"],
  ["max_tokens", "response_limit"], ["max_turn_requests", "response_limit"],
] as const) {
  test(`ACP ${reason} with valid usage still fails without retry`, async (t) => {
    const fixture = failureFixture(t, { result: { stopReason: reason, usage: USAGE } });
    await assertFailure(fixture, kind);
    assert.equal(fixture.launches().length, 1);
  });
}
for (const result of [{ usage: USAGE }, { stopReason: "unknown", usage: USAGE }]) {
  test(`ACP usage cannot supply a missing or unknown stopReason: ${JSON.stringify(result)}`, async (t) => {
    const fixture = failureFixture(t, { result });
    await assertFailure(fixture, "protocol_error");
    assert.equal(fixture.launches().length, 1);
  });
}
for (const valid of [true, false]) {
  test(`ACP end_turn preserves completion with valid usage=${valid}`, async (t) => {
    const fixture = failureFixture(t, {
      result: { stopReason: "end_turn", usage: valid ? USAGE : { ...USAGE, totalTokens: 1 } },
    });
    const stats: RunStat[] = [];
    const out = await runCodex("prompt", { ...fixture.options, onStat: (stat) => stats.push(stat) });
    assert.equal(out, '{"ok":true}');
    assert.equal(stats.length, 1);
    assert.equal(stats[0].ok, true);
    assert.equal(stats[0].attempts, 1);
    assert.deepEqual(stats[0].usage, valid ? USAGE : undefined);
    assertDisposed(fixture);
  });
}
test("ACP permission failure stays sticky when late end_turn carries usage", async (t) => {
  const fixture = failureFixture(t, {
    permission: true, lateSuccess: true, result: { stopReason: "end_turn", usage: USAGE },
  });
  await assertFailure(fixture, "permission_required");
  assert.equal(fixture.launches().length, 1);
});
test("ACP recovered attempt retains its usage and the previous failure transcript", async (t) => {
  const fixture = failureFixture(t, {
    error: { code: -32603, message: PRIVATE_TEXT }, recover: true,
    result: { stopReason: "end_turn", usage: USAGE },
  });
  const stats: RunStat[] = [];
  const failed: string[] = [];
  const out = await runCodex("prompt", {
    ...fixture.options, onStat: (stat) => stats.push(stat), onFailedRaw: (raw) => failed.push(raw),
  });
  assert.equal(out, '{"ok":true}');
  assert.equal(stats.length, 1);
  assert.equal(stats[0].ok, true);
  assert.equal(stats[0].attempts, 2);
  assert.deepEqual(stats[0].usage, USAGE);
  assert.equal(failed.length, 1);
  assert.match(failed[0], /private-token-and-prompt-canary/);
  assert.equal(fixture.launches().length, 2);
  assertDisposed(fixture);
});

async function assertFailure(fixture: ReturnType<typeof failureFixture>, kind: RunnerFailureKind, attempts = 1): Promise<void> {
  const failed: string[] = [];
  const successes: string[] = [];
  const stats: RunStat[] = [];
  const attempted: number[] = [];
  await assert.rejects(() => runCodex("prompt", {
    ...fixture.options,
    onFailedRaw: (raw) => failed.push(raw), onRaw: (raw) => successes.push(raw),
    onStat: (stat) => stats.push(stat), onFailedAttempt: (attempt) => attempted.push(attempt),
  }), (error: unknown) => {
    assert.ok(error instanceof RunnerOperationalError);
    assert.equal(findRunnerFailure(error)?.kind, kind);
    assert.equal(findRunnerFailure(error)?.retryable, kind === "unknown");
    assert.doesNotMatch(error.message, /private-token-and-prompt-canary|no JSON object found/);
    assert.doesNotMatch(JSON.stringify(error), /private-token-and-prompt-canary/);
    return true;
  });
  assert.equal(failed.length, attempts);
  assert.ok(failed.every((raw) => raw.includes(PRIVATE_TEXT)), "failed transcript must reach canary callbacks");
  assert.equal(successes.length, 0);
  assert.deepEqual(attempted, Array.from({ length: attempts }, (_, i) => i + 1));
  assert.equal(stats.length, 1);
  assert.equal(stats[0].attempts, attempts);
  assert.equal(stats[0].ok, false);
  assert.equal(stats[0].usage, undefined, "failed calls do not publish successful usage telemetry");
  assertDisposed(fixture);
}

function assertDisposed(fixture: ReturnType<typeof failureFixture>): void {
  for (const launch of fixture.launches()) {
    assert.equal(typeof launch.cwd, "string");
    assert.equal(typeof launch.home, "string");
    assert.equal(existsSync(launch.cwd as string), false, "throwaway clone must be disposed");
    assert.equal(existsSync(launch.home as string), false, "ephemeral HOME must be disposed");
  }
  assert.equal(headSha(fixture.options.repoPath), fixture.options.targetHeadSha);
}

function failureFixture(t: TestContext, scenario: Scenario) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-acp-failure-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "agent.cjs");
  const log = path.join(tmp, "client.ndjson");
  const launches = path.join(tmp, "launches.ndjson");
  const home = path.join(tmp, "operator-home");
  mkdirSync(home);
  const env = {
    NEEDLEFISH_ACP_BIN: bin, NEEDLEFISH_NO_RETRY: "0", NEEDLEFISH_RETRY_MS: "1",
    NEEDLEFISH_EPHEMERAL_HOME: "1", NEEDLEFISH_ACP_AUTH_FILES: "",
    NEEDLEFISH_ACP_AUTH_ENV_VARS: "TEST_ACP_TOKEN", NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "TEST_ACP_TOKEN",
    TEST_ACP_TOKEN: "fake-agent-token", HOME: home, USERPROFILE: home,
    NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS: "25", NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "500",
    NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS: "100",
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(tmp, { recursive: true, force: true });
  });
  Object.assign(process.env, env);
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const scenario = ${JSON.stringify(scenario)};
const log = ${JSON.stringify(log)};
const launches = ${JSON.stringify(launches)};
const privateText = ${JSON.stringify(PRIVATE_TEXT)};
fs.appendFileSync(launches, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.HOME }) + '\\n');
const attempt = fs.readFileSync(launches, 'utf8').trim().split('\\n').length;
process.on('SIGTERM', () => {});
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n');
const update = { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"ok":true}' } } } };
let promptId;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  fs.appendFileSync(log, line + '\\n');
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });
  else if (request.method === 'session/new') send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'sess' } });
  else if (request.method === 'session/cancel' && !scenario.stubborn) {
    send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'cancelled' } });
    setTimeout(() => process.exit(0), 20);
  } else if (request.method === 'session/prompt') {
    promptId = request.id;
    // Diagnostic stderr must stay in failed transcripts, not public errors.
    process.stderr.write(privateText + '\\n');
    if (scenario.malformed) process.stdout.write('not-json ' + privateText + '\\n');
    else if (scenario.permission) {
      const pending = ['permission-a', 'permission-b'].map((id) => ({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'sess', toolCall: { toolCallId: id, title: privateText }, options: [{ optionId: 'allow', name: 'allow', kind: 'allow_once' }] } }));
      const late = scenario.lateSuccess ? [update, { jsonrpc: '2.0', id: promptId, result: scenario.result ?? { stopReason: 'end_turn' } }] : [];
      process.stdout.write([...pending, ...late].map(JSON.stringify).join('\\n') + '\\n');
    } else {
      send(update);
      if (Object.hasOwn(scenario, 'error') && !(scenario.recover && attempt > 1)) send({ jsonrpc: '2.0', id: promptId, error: scenario.error });
      else send({ jsonrpc: '2.0', id: promptId, result: scenario.recover ? (scenario.result ?? { stopReason: 'end_turn' }) : scenario.result });
      setTimeout(() => process.exit(0), 20);
    }
  }
});
setInterval(() => {}, 1000);
`);
  chmodSync(bin, 0o755);
  return {
    options: { repoPath: repo, targetHeadSha: headSha(repo), runner: "acp" as const, timeoutMs: 3000 },
    transcript: () => readRecords(log), launches: () => readRecords(launches),
  };
}

function readRecords(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}
