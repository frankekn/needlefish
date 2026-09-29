import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodex } from "./codex";
import { resolveRunnerBinary, runnerCommand } from "./runner-detection";
import { RUNNER_DEFINITIONS, RUNNERS } from "./runner";
import { headSha, initRepo } from "./codex-runner-test-fixtures";
import { captureEnv, restoreEnv } from "./runner-test-fixtures";

const RUNNER_ENV_KEYS = ["PATH", "CODEX_BIN", "CLAUDE_BIN", "OPENCODE_BIN", "NEEDLEFISH_RUNNER"] as const;

test("runCodex auto-detects claude when codex is missing", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-detect-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const claude = path.join(fakeBin, "claude");
  const inputPath = path.join(tmp, "stdin.txt");
  const previous = captureEnv(RUNNER_ENV_KEYS);
  t.after(() => {
    restoreEnv(previous);
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
  const previous = captureEnv(RUNNER_ENV_KEYS);
  t.after(() => {
    restoreEnv(previous);
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
    /No supported model runner found on PATH\.\nInstall one:\n {2}codex: npm install -g @openai\/codex\n {2}claude: npm install -g @anthropic-ai\/claude-code\n {2}opencode: npm install -g @opencode\/cli/
  );
});

function clearRunnerEnv(pathValue: string): void {
  process.env.PATH = pathValue;
  delete process.env.CODEX_BIN;
  delete process.env.CLAUDE_BIN;
  delete process.env.OPENCODE_BIN;
  delete process.env.NEEDLEFISH_RUNNER;
}

// Regression: detection once trimmed CODEX_BIN while the spawn used it raw, so
// a padded override was auto-detected and then failed ENOENT. Both now read the
// value through runnerCommand, which trims it.
test("runCodex spawns a padded CODEX_BIN trimmed, the way detection resolved it", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-detect-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const inputPath = path.join(tmp, "stdin.txt");
  const previous = captureEnv(RUNNER_ENV_KEYS);
  t.after(() => {
    restoreEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(fakeBin);
  for (const name of ["codex", "claude"]) {
    const file = path.join(fakeBin, name);
    writeFileSync(file, ["#!/bin/sh", `cat > ${JSON.stringify(inputPath)}`, `printf '{"runner":"${name}"}'`].join("\n"));
    chmodSync(file, 0o755);
  }
  clearRunnerEnv(`/usr/bin:/bin:/usr/sbin:/sbin`);
  process.env.CLAUDE_BIN = path.join(fakeBin, "claude");
  process.env.CODEX_BIN = ` ${path.join(fakeBin, "codex")} \n`;

  const output = await runCodex("prompt", {
    repoPath: repo,
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output, '{"runner":"codex"}');
});

// Issue #201 item 1: codex on PATH and CODEX_BIN="" passed doctor, then the
// review spawned "" ("The argument 'file' cannot be empty").
test("runCodex treats an empty CODEX_BIN as unset and spawns codex from PATH", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-detect-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const previous = captureEnv(RUNNER_ENV_KEYS);
  t.after(() => {
    restoreEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(fakeBin);
  const codex = path.join(fakeBin, "codex");
  writeFileSync(codex, ["#!/bin/sh", "cat > /dev/null", `printf '{"runner":"codex"}'`].join("\n"));
  chmodSync(codex, 0o755);
  clearRunnerEnv(`${fakeBin}:/usr/bin:/bin:/usr/sbin:/sbin`);
  process.env.CODEX_BIN = "";

  const output = await runCodex("prompt", {
    runner: "codex",
    repoPath: repo,
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output, '{"runner":"codex"}');
});

test("runnerCommand trims every *_BIN override and treats blank as unset", (t) => {
  const previous = captureEnv(RUNNERS.map((name) => RUNNER_DEFINITIONS[name].bin?.env ?? "").filter(Boolean));
  t.after(() => restoreEnv(previous));
  for (const name of RUNNERS) {
    const bin = RUNNER_DEFINITIONS[name].bin;
    if (bin === undefined) {
      assert.equal(runnerCommand(name), undefined, name);
      continue;
    }
    for (const blank of [undefined, "", "  ", "\n"]) {
      if (blank === undefined) delete process.env[bin.env];
      else process.env[bin.env] = blank;
      assert.equal(runnerCommand(name), bin.fallback, `${name} with ${JSON.stringify(blank)}`);
    }
    process.env[bin.env] = " /opt/tools/agent \n";
    assert.equal(runnerCommand(name), "/opt/tools/agent", name);
    assert.equal(resolveRunnerBinary(name)?.command, "/opt/tools/agent", name);
  }
});
