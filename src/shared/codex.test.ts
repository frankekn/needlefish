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
