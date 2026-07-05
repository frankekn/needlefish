import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodex } from "./codex";
import { headSha, initRepo } from "./codex-runner-test-fixtures";

test("runCodex auto-detects claude when codex is missing", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-detect-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const claude = path.join(fakeBin, "claude");
  const inputPath = path.join(tmp, "stdin.txt");
  const previous = saveRunnerEnv();
  t.after(() => {
    restoreRunnerEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(fakeBin);
  writeFileSync(
    claude,
    [
      "#!/bin/sh",
      `cat > ${JSON.stringify(inputPath)}`,
      "printf '{\"ok\":true}'",
    ].join("\n")
  );
  chmodSync(claude, 0o755);
  clearRunnerEnv(`${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`);

  const output = await runCodex("prompt", {
    repoPath: repo,
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output, "{\"ok\":true}");
  assert.equal(readFileSync(inputPath, "utf8"), "prompt");
});

test("runCodex gives install commands when no auto-detected runner exists", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-detect-test-"));
  const repo = initRepo(tmp);
  const previous = saveRunnerEnv();
  t.after(() => {
    restoreRunnerEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });

  clearRunnerEnv("/usr/bin:/bin:/usr/sbin:/sbin");

  await assert.rejects(
    () =>
      runCodex("prompt", {
        repoPath: repo,
        targetHeadSha: headSha(repo),
        timeoutMs: 1000,
      }),
    /No supported model runner found on PATH\.\nInstall one:\n  codex: npm install -g @openai\/codex\n  claude: npm install -g @anthropic-ai\/claude-code\n  opencode: npm install -g opencode-ai/
  );
});

interface RunnerEnv {
  readonly path: string | undefined;
  readonly codexBin: string | undefined;
  readonly claudeBin: string | undefined;
  readonly opencodeBin: string | undefined;
  readonly runner: string | undefined;
}

function saveRunnerEnv(): RunnerEnv {
  return {
    path: process.env.PATH,
    codexBin: process.env.CODEX_BIN,
    claudeBin: process.env.CLAUDE_BIN,
    opencodeBin: process.env.OPENCODE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
  };
}

function restoreRunnerEnv(env: RunnerEnv): void {
  restoreEnv("PATH", env.path);
  restoreEnv("CODEX_BIN", env.codexBin);
  restoreEnv("CLAUDE_BIN", env.claudeBin);
  restoreEnv("OPENCODE_BIN", env.opencodeBin);
  restoreEnv("NEEDLEFISH_RUNNER", env.runner);
}

function clearRunnerEnv(pathValue: string): void {
  process.env.PATH = pathValue;
  delete process.env.CODEX_BIN;
  delete process.env.CLAUDE_BIN;
  delete process.env.OPENCODE_BIN;
  delete process.env.NEEDLEFISH_RUNNER;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
