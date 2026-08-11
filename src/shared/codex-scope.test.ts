import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runCodex } from "./codex";
import { headSha, initRepo, readStringArray } from "./codex-runner-test-fixtures";

test("runCodex hides dirty target files from codex runner", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const argsPath = path.join(tmp, "args.json");
  const previous = process.env.CODEX_BIN;
  const previousReasoningEffort = process.env.CODEX_REASONING_EFFORT;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    if (previousReasoningEffort === undefined) delete process.env.CODEX_REASONING_EFFORT;
    else process.env.CODEX_REASONING_EFFORT = previousReasoningEffort;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "fs.writeFileSync(out, JSON.stringify({ dirtyVisible: fs.existsSync('dirty-only.txt'), cwd: process.cwd() }));",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(repo, "dirty-only.txt"), "dirty");
  process.env.CODEX_BIN = bin;
  delete process.env.CODEX_REASONING_EFFORT;

  const output = await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output.includes('"dirtyVisible":false'), true);
  assert.equal(output.includes(repo), false);
  const args = readStringArray(argsPath);
  assert.equal(args.includes("--ignore-user-config"), true);
  assert.equal(args.includes('model_reasoning_effort="medium"'), true);
});

function setupCodexStub(t: TestContext): { repo: string; argsPath: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const argsPath = path.join(tmp, "args.json");
  const previousBin = process.env.CODEX_BIN;
  const previousServiceTier = process.env.CODEX_SERVICE_TIER;
  const previousNoRetry = process.env.NEEDLEFISH_NO_RETRY;
  t.after(() => {
    if (previousBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBin;
    if (previousServiceTier === undefined) delete process.env.CODEX_SERVICE_TIER;
    else process.env.CODEX_SERVICE_TIER = previousServiceTier;
    if (previousNoRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
    else process.env.NEEDLEFISH_NO_RETRY = previousNoRetry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "fs.writeFileSync(out, 'ok');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  delete process.env.CODEX_SERVICE_TIER;
  return { repo, argsPath };
}

function runStubbedCodex(repo: string): Promise<string> {
  return runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });
}

test("runCodex omits service_tier when CODEX_SERVICE_TIER is unset", async (t) => {
  const { repo, argsPath } = setupCodexStub(t);

  await runStubbedCodex(repo);

  const args = readStringArray(argsPath);
  assert.equal(
    args.some((arg) => arg.includes("service_tier")),
    false
  );
});

test("runCodex passes CODEX_SERVICE_TIER to codex as a -c override", async (t) => {
  const { repo, argsPath } = setupCodexStub(t);
  process.env.CODEX_SERVICE_TIER = "fast";

  await runStubbedCodex(repo);

  const args = readStringArray(argsPath);
  const index = args.indexOf('service_tier="fast"');
  assert.notEqual(index, -1);
  assert.equal(args[index - 1], "-c");
});

test("runCodex rejects an invalid CODEX_SERVICE_TIER", async (t) => {
  const { repo } = setupCodexStub(t);
  process.env.CODEX_SERVICE_TIER = "bogus";
  // Retry would run the same doomed invocation twice with a 5s backoff.
  process.env.NEEDLEFISH_NO_RETRY = "1";

  await assert.rejects(runStubbedCodex(repo), {
    message: "CODEX_SERVICE_TIER must be one of: fast, priority",
  });
});
