import assert from "node:assert/strict";
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { resolveRunnerConfig, runCodex } from "./codex.js";
import { prepareCapturedCodexHome } from "./codex-invocation.js";
import { headSha, initRepo, isolateCodexTestHome } from "./codex-runner-test-fixtures.js";
import { findRunnerFailure } from "./runner-failure.js";

function environment(t: TestContext, name: string, value: string): void {
  const previous = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "nf-captured-exe-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  isolateCodexTestHome(t, root);
  for (const [name, value] of Object.entries({
    CODEX_BIN: path.join(root, "codex.cjs"),
    NEEDLEFISH_EPHEMERAL_HOME: "1", NEEDLEFISH_NO_RETRY: "1",
    NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "", CODEX_REASONING_EFFORT: "medium",
    CODEX_SERVICE_TIER: "", CODEX_PROXY_BASE_URL: "", CODEX_PROXY_API_KEY: "",
    NEEDLEFISH_CODEX_PROXY_REQUIRED: "0",
  })) environment(t, name, value);
  const authRoot = path.join(root, ".codex");
  mkdirSync(authRoot);
  const auth = '{"synthetic":"owned-capture-auth"}';
  writeFileSync(path.join(authRoot, "auth.json"), auth);
  const binary = path.join(root, "codex.cjs");
  const observed = path.join(root, "observed.json");
  const executable = (name: string, label: string) => writeFileSync(name, [
    `#!${process.execPath}`,
    "const fs = require('node:fs'); const path = require('node:path');",
    "fs.readFileSync(0, 'utf8');",
    `fs.writeFileSync(${JSON.stringify(observed)}, JSON.stringify({ label: ${JSON.stringify(label)}, auth: fs.readFileSync(path.join(process.env.CODEX_HOME, 'auth.json'), 'utf8') }));`,
    "fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], 'captured runner completed');",
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'owned-capture-thread' }));",
    "console.log(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }));",
  ].join("\n"), { mode: 0o755 });
  executable(binary, "original");
  const repoPath = initRepo(root);
  const config = resolveRunnerConfig({ runner: "codex", timeoutMs: 5000 });
  const run = (onLfsReport?: () => void) => runCodex("check source", { effectiveConfig: config, repoPath, targetHeadSha: headSha(repoPath), onLfsReport });
  return { root, binary, observed, executable, config, run, auth, authRoot };
}

for (const mutation of ["replace", "rewrite", "remove", "symlink"] as const) {
  test(`captured Codex rejects executable ${mutation} before staging credentials or spawning`, async t => {
    const f = fixture(t);
    if (mutation === "remove") unlinkSync(f.binary);
    else if (mutation === "rewrite") f.executable(f.binary, "replacement");
    else {
      const replacement = path.join(f.root, "replacement.cjs");
      f.executable(replacement, "replacement");
      if (mutation === "symlink") {
        unlinkSync(f.binary);
        symlinkSync(replacement, f.binary);
      } else renameSync(replacement, f.binary);
    }
    await assert.rejects(f.run(), { name: "RunnerOperationalError", message: /captured Codex executable changed/ });
    assert.equal(existsSync(f.observed), false);
    const staging = path.join(f.root, "staging");
    assert.throws(() => prepareCapturedCodexHome(f.config, staging), /captured Codex executable changed/);
    assert.equal(existsSync(path.join(staging, "home")), false);
  });
}

test("captured Codex executable drift fails once with ordinary retries enabled", async t => {
  const f = fixture(t);
  environment(t, "NEEDLEFISH_NO_RETRY", "0");
  const replacement = path.join(f.root, "replacement.cjs");
  f.executable(replacement, "replacement");
  renameSync(replacement, f.binary);
  const failedAttempts: number[] = [];
  let failure: unknown;
  const writes = t.mock.method(fs, "writeFileSync");
  syncBuiltinESMExports();
  try {
    await assert.rejects(runCodex("check source", {
      effectiveConfig: f.config,
      repoPath: path.join(f.root, "repo"),
      targetHeadSha: headSha(path.join(f.root, "repo")),
      onFailedAttempt: attempt => failedAttempts.push(attempt),
    }), error => {
      failure = error;
      return error instanceof Error && error.name === "RunnerOperationalError" && /captured Codex executable changed/.test(error.message);
    });
    assert.deepEqual(failedAttempts, [1]);
    assert.equal(findRunnerFailure(failure)?.kind, "startup_failed");
    assert.equal(findRunnerFailure(failure)?.retryable, false);
    assert.equal(existsSync(f.observed), false);
    assert.equal(writes.mock.calls.filter(call => typeof call.arguments[0] === "string" && path.basename(call.arguments[0]) === "auth.json").length, 0);
  } finally {
    writes.mock.restore();
    syncBuiltinESMExports();
  }
});

test("captured Codex rechecks the executable after preparation callbacks", async t => {
  const f = fixture(t);
  await assert.rejects(f.run(() => {
    const replacement = path.join(f.root, "replacement.cjs");
    f.executable(replacement, "replacement");
    renameSync(replacement, f.binary);
  }), { name: "RunnerOperationalError", message: /captured Codex executable changed/ });
  assert.equal(existsSync(f.observed), false);
});

test("unchanged Codex executes with frozen auth despite environment and auth-source drift", async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.authRoot, "auth.json"), '{"synthetic":"new-auth-source"}');
  environment(t, "CODEX_REASONING_EFFORT", "high");
  assert.equal(await f.run(), "captured runner completed");
  assert.deepEqual(JSON.parse(readFileSync(f.observed, "utf8")), { label: "original", auth: f.auth });
});
