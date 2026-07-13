import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runCodex } from "./codex";
import { headSha, initRepo } from "./codex-runner-test-fixtures";

type AcpStubMode = "clean" | "error" | "malformed" | "hang";

interface AcpFixture {
  readonly tmp: string;
  readonly repo: string;
  readonly envPath: string;
  readonly transcriptPath: string;
  readonly pgidPath: string;
}

test("runCodex acp clean stub returns agent text", async (t) => {
  const fixture = acpFixture(t, "clean");
  process.env.GH_TOKEN = "secret-gh";
  process.env.GITHUB_TOKEN = "secret-github";
  process.env.GITHUB_API_TOKEN = "secret-api";

  const output = await runAcpPrompt(fixture, 1000);

  assert.equal(output, '{"ok":true}');
  assert.deepEqual(readJsonRecord(fixture.envPath), {});
  const transcript = readFileSync(fixture.transcriptPath, "utf8");
  assert.match(transcript, /"method":"initialize"/);
  assert.match(transcript, /"method":"session\/new"/);
  assert.match(transcript, /"method":"session\/prompt"/);
});

test("runCodex acp env credentials use and dispose the isolated HOME", async (t) => {
  const fixture = acpFixture(t, "clean");
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "needlefish-fakehome-"));
  const previous = captureEnv([
    "NEEDLEFISH_EPHEMERAL_HOME",
    "NEEDLEFISH_ACP_AUTH_FILES",
    "NEEDLEFISH_ACP_AUTH_ENV_VARS",
    "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH",
    "MY_AGENT_TOKEN",
    "HOME",
    "USERPROFILE",
  ]);
  t.after(() => {
    restoreEnv(previous);
    rmSync(fakeHome, { recursive: true, force: true });
  });
  process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
  delete process.env.NEEDLEFISH_ACP_AUTH_FILES;
  process.env.NEEDLEFISH_ACP_AUTH_ENV_VARS = "MY_AGENT_TOKEN";
  process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "MY_AGENT_TOKEN";
  process.env.MY_AGENT_TOKEN = "agent-secret";
  process.env.HOME = fakeHome;
  delete process.env.USERPROFILE;

  const output = await runAcpPrompt(fixture, 1000);

  assert.equal(output, '{"ok":true}');
  const dumped = readJsonRecord(fixture.envPath);
  assert.equal(dumped.MY_AGENT_TOKEN, "agent-secret");
  assert.equal(dumped.HOME, dumped.USERPROFILE);
  assert.notEqual(dumped.HOME, fakeHome);
  assert.equal(typeof dumped.HOME, "string");
  assert.equal(existsSync(dumped.HOME as string), false, "isolated HOME must be disposed");
});

test("runCodex acp surfaces session prompt JSON-RPC errors", async (t) => {
  const fixture = acpFixture(t, "error");

  await assert.rejects(() => runAcpPrompt(fixture, 1000), /acp session\/prompt failed: prompt failed/);
});

test("runCodex acp rejects malformed stdout without hanging", async (t) => {
  const fixture = acpFixture(t, "malformed");

  await assert.rejects(() => runAcpPrompt(fixture, 1000), /malformed ACP JSON-RPC/);
});

test("runCodex acp times out silent runner and kills process group", { timeout: 6_000 }, async (t) => {
  const fixture = acpFixture(t, "hang");
  process.env.NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS = "25";
  process.env.NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS = "50";
  process.env.NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS = "50";
  let pgid: number | undefined;

  try {
    await assert.rejects(() => runAcpPrompt(fixture, 500), /ETIMEDOUT/);
    pgid = Number(readFileSync(fixture.pgidPath, "utf8"));
    const groupId = pgid;
    assert.match(readFileSync(fixture.transcriptPath, "utf8"), /"method":"session\/cancel"/);
    await waitForMissingProcessGroup(groupId, 1000);
    assert.throws(() => process.kill(-groupId, 0), isMissingProcess);
  } finally {
    if (pgid !== undefined) {
      killProcessIfRunning(-pgid);
    }
  }
});

test("runCodex acp requires NEEDLEFISH_ACP_BIN", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const previous = captureEnv(["NEEDLEFISH_ACP_BIN", "NEEDLEFISH_NO_RETRY"]);
  t.after(() => {
    restoreEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });
  delete process.env.NEEDLEFISH_ACP_BIN;
  process.env.NEEDLEFISH_NO_RETRY = "1";

  await assert.rejects(
    () =>
      runCodex("prompt", {
        repoPath: repo,
        runner: "acp",
        targetHeadSha: headSha(repo),
        timeoutMs: 1000,
      }),
    /NEEDLEFISH_ACP_BIN is required/
  );
});

function acpFixture(t: TestContext, mode: AcpStubMode): AcpFixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "acp-bin.js");
  const envPath = path.join(tmp, "env.json");
  const transcriptPath = path.join(tmp, "transcript.ndjson");
  const pgidPath = path.join(tmp, "pgid");
  const previous = captureEnv([
    "NEEDLEFISH_ACP_BIN",
    "NEEDLEFISH_NO_RETRY",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_API_TOKEN",
    "NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS",
    "NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS",
    "NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS",
  ]);
  t.after(() => {
    restoreEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });
  writeAcpStub({ bin, mode, envPath, transcriptPath, pgidPath });
  process.env.NEEDLEFISH_ACP_BIN = bin;
  process.env.NEEDLEFISH_NO_RETRY = "1";
  return { tmp, repo, envPath, transcriptPath, pgidPath };
}

function writeAcpStub(options: {
  readonly bin: string;
  readonly mode: AcpStubMode;
  readonly envPath: string;
  readonly transcriptPath: string;
  readonly pgidPath: string;
}): void {
  writeFileSync(
    options.bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const readline = require('node:readline');",
      `const mode = ${JSON.stringify(options.mode)};`,
      `const envPath = ${JSON.stringify(options.envPath)};`,
      `const transcriptPath = ${JSON.stringify(options.transcriptPath)};`,
      `const pgidPath = ${JSON.stringify(options.pgidPath)};`,
      "fs.writeFileSync(pgidPath, String(process.pid));",
      "const picked = {};",
      "for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GITHUB_API_TOKEN']) {",
      "  if (process.env[key] !== undefined) picked[key] = process.env[key];",
      "}",
      "if (process.env.MY_AGENT_TOKEN !== undefined) {",
      "  picked.MY_AGENT_TOKEN = process.env.MY_AGENT_TOKEN;",
      "  picked.HOME = process.env.HOME;",
      "  picked.USERPROFILE = process.env.USERPROFILE;",
      "}",
      "fs.writeFileSync(envPath, JSON.stringify(picked));",
      "if (mode === 'malformed') {",
      "  process.stdout.write('not json\\n');",
      "  setInterval(() => {}, 1000);",
      "} else {",
      "  process.on('SIGTERM', () => {});",
      "  const send = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`);",
      "  const update = (text) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });",
      "  readline.createInterface({ input: process.stdin }).on('line', (line) => {",
      "    fs.appendFileSync(transcriptPath, line + '\\n');",
      "    const request = JSON.parse(line);",
      "    if (request.method === 'initialize') {",
      "      send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: 1, agentCapabilities: {} } });",
      "    } else if (request.method === 'session/new') {",
      "      send({ jsonrpc: '2.0', id: request.id, result: { sessionId: 'sess' } });",
      "    } else if (request.method === 'session/prompt' && mode === 'clean') {",
      "      update('{\"ok\"');",
      "      update(':true}');",
      "      send({ jsonrpc: '2.0', id: request.id, result: { stopReason: 'end_turn' } });",
      "      setTimeout(() => process.exit(0), 10);",
      "    } else if (request.method === 'session/prompt' && mode === 'error') {",
      "      send({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'prompt failed' } });",
      "      setTimeout(() => process.exit(0), 10);",
      "    }",
      "  });",
      "  setInterval(() => {}, 1000);",
      "}",
    ].join("\n")
  );
  chmodSync(options.bin, 0o755);
}

async function runAcpPrompt(fixture: AcpFixture, timeoutMs: number): Promise<string> {
  return await runCodex("prompt", {
    repoPath: fixture.repo,
    runner: "acp",
    targetHeadSha: headSha(fixture.repo),
    timeoutMs,
  });
}

function captureEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(previous: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function readJsonRecord(file: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isJsonRecord(raw)) throw new Error("expected JSON object");
  return raw;
}

function isJsonRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

async function waitForMissingProcessGroup(pgid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (isMissingProcess(error)) return;
      throw error;
    }
    await delay(25);
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

function killProcessIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}
