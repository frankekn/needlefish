import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function setupCodexStub(t: TestContext): { repo: string; argsPath: string; envPath: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const argsPath = path.join(tmp, "args.json");
  const envPath = path.join(tmp, "env.json");
  const previousBin = process.env.CODEX_BIN;
  const previousServiceTier = process.env.CODEX_SERVICE_TIER;
  const previousNoRetry = process.env.NEEDLEFISH_NO_RETRY;
  const previousProxy = {
    baseUrl: process.env.CODEX_PROXY_BASE_URL,
    key: process.env.CODEX_PROXY_API_KEY,
    required: process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED,
  };
  t.after(() => {
    if (previousBin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previousBin;
    if (previousServiceTier === undefined) delete process.env.CODEX_SERVICE_TIER;
    else process.env.CODEX_SERVICE_TIER = previousServiceTier;
    if (previousNoRetry === undefined) delete process.env.NEEDLEFISH_NO_RETRY;
    else process.env.NEEDLEFISH_NO_RETRY = previousNoRetry;
    if (previousProxy.baseUrl === undefined) delete process.env.CODEX_PROXY_BASE_URL;
    else process.env.CODEX_PROXY_BASE_URL = previousProxy.baseUrl;
    if (previousProxy.key === undefined) delete process.env.CODEX_PROXY_API_KEY;
    else process.env.CODEX_PROXY_API_KEY = previousProxy.key;
    if (previousProxy.required === undefined) delete process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED;
    else process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED = previousProxy.required;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
      `fs.writeFileSync(${JSON.stringify(envPath)}, JSON.stringify({ key: process.env.CODEX_PROXY_API_KEY ?? null, baseUrl: process.env.CODEX_PROXY_BASE_URL ?? null, required: process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED ?? null }));`,
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "fs.writeFileSync(out, 'ok');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  delete process.env.CODEX_SERVICE_TIER;
  delete process.env.CODEX_PROXY_BASE_URL;
  delete process.env.CODEX_PROXY_API_KEY;
  delete process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED;
  return { repo, argsPath, envPath };
}

function runStubbedCodex(repo: string): Promise<string> {
  return runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });
}

for (const proxy of [false, true]) {
  for (const tier of [undefined, "fast", "priority", "bogus"]) {
    test(`runCodex validates service tier ${tier ?? "unset"} with proxy=${proxy}`, async (t) => {
      const { repo, argsPath } = setupCodexStub(t);
      if (proxy) {
        process.env.CODEX_PROXY_BASE_URL = "http://127.0.0.1:8317/v1";
        process.env.CODEX_PROXY_API_KEY = "proxy-secret-test-key";
        process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED = "1";
      }
      if (tier !== undefined) process.env.CODEX_SERVICE_TIER = tier;
      process.env.NEEDLEFISH_NO_RETRY = "1";

      if (tier === "bogus") {
        await assert.rejects(runStubbedCodex(repo), {
          message: "CODEX_SERVICE_TIER must be one of: fast, priority",
        });
        assert.equal(existsSync(argsPath), false);
        return;
      }

      await runStubbedCodex(repo);
      const args = readStringArray(argsPath);
      assert.deepEqual(
        args.filter((arg) => arg.startsWith("service_tier=")),
        tier === undefined ? [] : [`service_tier="${tier}"`],
      );
      if (tier !== undefined) {
        assert.equal(args[args.indexOf(`service_tier="${tier}"`) - 1], "-c");
      }
    });
  }
}

test("runCodex configures the fail-closed CLIProxyAPI provider without putting its key in argv", async (t) => {
  const { repo, argsPath, envPath } = setupCodexStub(t);
  process.env.CODEX_PROXY_BASE_URL = "http://127.0.0.1:8317/v1";
  process.env.CODEX_PROXY_API_KEY = " proxy-secret-test-key\n";
  process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED = "1";
  process.env.CODEX_SERVICE_TIER = "fast";

  await runStubbedCodex(repo);

  const args = readStringArray(argsPath);
  assert.equal(args.includes("--ignore-user-config"), true);
  for (const override of [
    'model_provider="cliproxyapi"',
    'model_providers.cliproxyapi.name="CLIProxyAPI"',
    'model_providers.cliproxyapi.base_url="http://127.0.0.1:8317/v1"',
    'model_providers.cliproxyapi.env_key="CODEX_PROXY_API_KEY"',
    'model_providers.cliproxyapi.wire_api="responses"',
    "model_providers.cliproxyapi.requires_openai_auth=false",
  ]) {
    const index = args.indexOf(override);
    assert.notEqual(index, -1, `missing Codex config override: ${override}`);
    assert.equal(args[index - 1], "-c");
  }
  assert.equal(JSON.stringify(args).includes("proxy-secret-test-key"), false);
  assert.equal(args.includes('service_tier="fast"'), true);
  assert.deepEqual(JSON.parse(readFileSync(envPath, "utf8")), {
    key: "proxy-secret-test-key",
    baseUrl: null,
    required: null,
  });
});

test("runCodex fails closed before invocation when the required proxy configuration is incomplete", async (t) => {
  const { repo, argsPath } = setupCodexStub(t);
  process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED = "1";

  await assert.rejects(runStubbedCodex(repo), {
    name: "RunnerOperationalError",
    message: /CODEX_PROXY_BASE_URL is required/,
  });
  assert.equal(existsSync(argsPath), false);

  process.env.CODEX_PROXY_BASE_URL = "http://127.0.0.1:8317/v1";
  await assert.rejects(runStubbedCodex(repo), {
    name: "RunnerOperationalError",
    message: /CODEX_PROXY_API_KEY is required/,
  });
  assert.equal(existsSync(argsPath), false);

  process.env.CODEX_PROXY_API_KEY = "   ";
  await assert.rejects(runStubbedCodex(repo), /CODEX_PROXY_API_KEY is required/);
  assert.equal(existsSync(argsPath), false);
});

test("runCodex treats partial optional proxy configuration as an error instead of falling back to OAuth", async (t) => {
  const { repo, argsPath } = setupCodexStub(t);
  process.env.CODEX_PROXY_API_KEY = "proxy-secret-test-key";

  await assert.rejects(runStubbedCodex(repo), /CODEX_PROXY_BASE_URL is required/);
  assert.equal(existsSync(argsPath), false);
});

test("runCodex treats empty optional proxy variables as unconfigured", async (t) => {
  const { repo, argsPath } = setupCodexStub(t);
  process.env.CODEX_PROXY_BASE_URL = "";
  process.env.CODEX_PROXY_API_KEY = "";

  await runStubbedCodex(repo);

  const args = readStringArray(argsPath);
  assert.equal(args.some((arg) => arg.includes("model_provider")), false);
});

// The runner, not a test helper, is the adversary: this stub does exactly
// what a misbehaving CLI would do from inside its sandbox — enumerate
// remotes and try to push a scratch branch to origin — and the assertion is on
// the ORIGINAL repository's refs afterwards.
test("runCodex sandbox exposes no origin remote to the runner and rejects a push back to the source", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const previous = process.env.CODEX_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "const remotes = spawnSync('git', ['remote'], { encoding: 'utf8' }).stdout.trim();",
      "const push = spawnSync('git', ['push', '--quiet', 'origin', 'HEAD:refs/heads/needlefish-runner-scratch'], { encoding: 'utf8' });",
      "fs.writeFileSync(out, JSON.stringify({ remotes, pushStatus: push.status, pushStderr: push.stderr }));",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  const refsBefore = spawnSync("git", ["for-each-ref"], { cwd: repo, encoding: "utf8" }).stdout;

  const output = await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 5000,
  });

  const observed: unknown = JSON.parse(output);
  assert.ok(typeof observed === "object" && observed !== null);
  const { remotes, pushStatus, pushStderr } = observed as { remotes: string; pushStatus: number; pushStderr: string };
  assert.equal(remotes, "", "runner must see no remote inside the sandbox");
  assert.notEqual(pushStatus, 0, "push via origin must fail from inside the runner");
  assert.match(pushStderr, /'origin' does not appear to be a git repository/);
  assert.equal(spawnSync("git", ["for-each-ref"], { cwd: repo, encoding: "utf8" }).stdout, refsBefore, "source refs must be unchanged");
});

// A remote defined in the runner's GLOBAL gitconfig would survive
// severSourceRemote, which only edits the clone's own config. The runner env
// must drop global and system git config so that route cannot be resurrected.
test("runCodex sandbox ignores a global gitconfig remote pointing at the source", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "codex-bin.js");
  const previous = { bin: process.env.CODEX_BIN, home: process.env.HOME };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
    rmSync(tmp, { recursive: true, force: true });
  });
  mkdirSync(home);
  writeFileSync(
    path.join(home, ".gitconfig"),
    `[remote "origin"]\n\turl = ${repo}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`
  );
  spawnSync("git", ["branch", "victim"], { cwd: repo });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const { spawnSync } = require('node:child_process');",
      "const args = process.argv.slice(2);",
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "const remotes = spawnSync('git', ['remote'], { encoding: 'utf8' }).stdout.trim();",
      "const push = spawnSync('git', ['push', '--quiet', '--force', 'origin', 'HEAD:refs/heads/victim'], { encoding: 'utf8' });",
      "fs.writeFileSync(out, JSON.stringify({ remotes, pushStatus: push.status }));",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.HOME = home;
  const victimBefore = spawnSync("git", ["rev-parse", "victim"], { cwd: repo, encoding: "utf8" }).stdout;

  const output = await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 5000,
  });

  const observed: unknown = JSON.parse(output);
  assert.ok(typeof observed === "object" && observed !== null);
  const { remotes, pushStatus } = observed as { remotes: string; pushStatus: number };
  assert.equal(remotes, "", "global gitconfig remote must not be visible inside the sandbox");
  assert.notEqual(pushStatus, 0, "push via a global-config origin must fail");
  assert.equal(spawnSync("git", ["rev-parse", "victim"], { cwd: repo, encoding: "utf8" }).stdout, victimBefore, "source branch must be unchanged");
});
