import assert from "node:assert/strict";
import test from "node:test";
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
