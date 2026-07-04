import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { spawnRunnerProcess } from "./runner-process";

test("spawnRunnerProcess reports EPIPE when stdin closes before prompt drains", async () => {
  const result = await spawnRunnerProcess({
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    stdin: "x".repeat(10_000_000),
    repoPath: process.cwd(),
    timeoutMs: 1000,
    env: process.env,
  });

  assert.match(result.error?.message ?? "", /EPIPE/);
});

test("spawnRunnerProcess reports ENOBUFS when stdout exceeds the buffer cap", async () => {
  const result = await spawnRunnerProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(70 * 1024 * 1024))"],
    stdin: "",
    repoPath: process.cwd(),
    timeoutMs: 5000,
    env: process.env,
  });

  assert.match(result.error?.message ?? "", /ENOBUFS/);
});

test("spawnRunnerProcess kills a SIGTERM-trapping process group after timeout", { timeout: 10_000 }, async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-process-test-"));
  const runner = path.join(tmp, "zombie-runner.js");
  const pgidPath = path.join(tmp, "pgid");
  const termPath = path.join(tmp, "term-seen");
  const timeoutMs = 200;
  const timeoutGraceMs = Number(process.env.NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS ?? 5000);
  const deadlineMs = timeoutMs + timeoutGraceMs + 2000;
  let pgid: number | undefined;

  writeFileSync(
    runner,
    [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(pgidPath)}, String(process.pid));`,
      "spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\"], { stdio: 'ignore' });",
      `process.on('SIGTERM', () => fs.writeFileSync(${JSON.stringify(termPath)}, '1'));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
  );
  chmodSync(runner, 0o755);

  try {
    const started = Date.now();
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new assert.AssertionError({
              message: "spawnRunnerProcess did not return within timeout plus grace margin",
            }),
          ),
        deadlineMs,
      );
      timer.unref();
    });
    const result = await Promise.race([
      spawnRunnerProcess({
        command: process.execPath,
        args: [runner],
        stdin: "",
        repoPath: tmp,
        timeoutMs,
        env: process.env,
      }),
      timeout,
    ]);
    const elapsedMs = Date.now() - started;

    const recordedPgid = Number(readFileSync(pgidPath, "utf8"));
    pgid = recordedPgid;
    const error = result.error;

    assert.ok(elapsedMs <= deadlineMs, `returned after ${elapsedMs}ms`);
    if (!(error instanceof Error) || !("code" in error)) {
      throw new assert.AssertionError({ message: "timeout should return a coded Error" });
    }
    assert.equal(error.code, "ETIMEDOUT");
    assert.match(error.message, /ETIMEDOUT/);
    assert.equal(result.status, null);
    assert.ok(existsSync(termPath), "runner process group should receive SIGTERM before SIGKILL");
    const groupGoneDeadline = Date.now() + 1000;
    while (Date.now() < groupGoneDeadline) {
      try {
        process.kill(-recordedPgid, 0);
      } catch (processError) {
        if (isMissingProcess(processError)) break;
        throw processError;
      }
      await delay(25);
    }
    assert.throws(() => process.kill(-recordedPgid, 0), isMissingProcess);
  } finally {
    if (pgid !== undefined) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        if (!isMissingProcess(error)) throw error;
      }
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
