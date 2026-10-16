import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { localDryRun, localPrDryRun } from "../adapters/local.js";
import { runCodex, RunnerOperationalError } from "./codex.js";
import { commitAll, headSha, initRepo } from "./codex-runner-test-fixtures.js";
import { resolveRunner, requireRunnerCommand } from "./runner-detection.js";
import { captureEnv, restoreEnv } from "./runner-test-fixtures.js";
import { spawnRunnerProcess } from "./runner-process.js";

test("opencode fails closed before any review, dry-run or direct launch can execute plugins", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-opencode-isolation-"));
  const repo = initRepo(tmp);
  const marker = path.join(tmp, "launched");
  const bin = path.join(tmp, "opencode");
  const previous = captureEnv(["OPENCODE_BIN", "NEEDLEFISH_RUNNER", "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH"]);
  t.after(() => { restoreEnv(previous); rmSync(tmp, { recursive: true, force: true }); });
  writeFileSync(bin, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
  chmodSync(bin, 0o755);
  process.env.OPENCODE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "OPENCODE_CONFIG_CONTENT,OPENCODE_CONFIG_PROJECT_DISABLE";
  const blocked = /OpenCode reviews are temporarily disabled.*issue #207/;
  for (const fromEnv of [false, true]) {
    if (fromEnv) process.env.NEEDLEFISH_RUNNER = "opencode";
    else delete process.env.NEEDLEFISH_RUNNER;
    const opts = fromEnv ? {} : { runner: "opencode" as const };
    assert.throws(() => resolveRunner(opts), blocked);
    assert.throws(() => localDryRun(repo, opts), blocked);
    assert.throws(() => localPrDryRun(repo, 1, opts), blocked);
    await assert.rejects(() => runCodex("read-only", { ...opts, repoPath: repo, targetHeadSha: headSha(repo) }), (error: unknown) => {
      assert.ok(error instanceof RunnerOperationalError);
      assert.match(error.message, blocked);
      return true;
    });
  }
  assert.throws(() => requireRunnerCommand("opencode"), blocked);
  assert.equal(existsSync(marker), false);
});

const integrationBin = process.env.NEEDLEFISH_OPENCODE_INTEGRATION_BIN;
test("real OpenCode committed target plugin cannot write outside the review clone", {
  skip: integrationBin === undefined ? "set NEEDLEFISH_OPENCODE_INTEGRATION_BIN to an installed OpenCode v2 CLI" : false,
}, async (t) => {
  assert.ok(integrationBin);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-opencode-real-"));
  const repo = initRepo(tmp);
  const home = path.join(tmp, "home");
  const marker = path.join(tmp, "outside-clone-marker");
  const plugin = path.join(repo, ".opencode", "plugins", "review-proof");
  mkdirSync(plugin, { recursive: true });
  mkdirSync(home);
  writeFileSync(path.join(plugin, "index.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'target plugin executed'); export default { id: 'review-proof', setup() {} };`);
  commitAll(repo, "committed plugin startup reproduction");
  const previous = captureEnv(["OPENCODE_BIN", "HOME", "USERPROFILE", "NEEDLEFISH_EPHEMERAL_HOME", "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", "OPENAI_API_KEY"]);
  t.after(() => { restoreEnv(previous); rmSync(tmp, { recursive: true, force: true }); });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share") };
  const version = spawnSync(integrationBin, ["--version"], { cwd: home, env, encoding: "utf8", timeout: 5000 });
  assert.equal(version.status, 0);
  assert.match(version.stdout, /opencode v2\./);
  t.diagnostic(version.stdout.trim());
  await spawnRunnerProcess({
    command: integrationBin,
    args: ["run", "--standalone", "--format", "json", "--model", "needlefish-nonexistent-provider/nonexistent-model", "Read-only review. Do not load project plugins."],
    stdin: "",
    repoPath: repo,
    timeoutMs: 20000,
    env,
  });
  assert.equal(existsSync(marker), true, "the real CLI must reproduce plugin startup without model credentials");
  rmSync(marker);
  Object.assign(process.env, { OPENCODE_BIN: integrationBin, HOME: home, USERPROFILE: home, NEEDLEFISH_EPHEMERAL_HOME: "1", OPENAI_API_KEY: "dummy-local-proof-not-a-credential" });
  delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
  await assert.rejects(() => runCodex("Read-only review. Do not load project plugins.", { runner: "opencode", repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 20000, model: "needlefish-nonexistent-provider/nonexistent-model" }), /OpenCode reviews are temporarily disabled/);
  assert.equal(existsSync(marker), false);
  t.diagnostic("unprotected startup marker: true; Needlefish startup marker: false");
});
