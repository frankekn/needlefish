import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodex } from "./codex";
import { resolveCallerCommand, resolveRunnerBinary, runnerCommand } from "./runner-detection";
import { RUNNER_DEFINITIONS, RUNNERS } from "./runner";
import { commitAll, headSha, initRepo } from "./codex-runner-test-fixtures";
import { captureEnv, restoreEnv } from "./runner-test-fixtures";

const RUNNER_ENV_KEYS = ["PATH", "CODEX_BIN", "CLAUDE_BIN", "OPENCODE_BIN", "GROK_BIN", "NEEDLEFISH_RUNNER"] as const;

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


for (const runner of ["codex", "grok", "claude"] as const) {
  test(`${runner} resolves a relative executable from the caller, never the PR clone`, async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-relative-codex-"));
    const repo = initRepo(tmp);
    const caller = path.join(tmp, "caller");
    const attackMarker = path.join(tmp, "untrusted-executed");
    const previous = captureEnv(RUNNER_ENV_KEYS);
    const previousCwd = process.cwd();
    t.after(() => {
      process.chdir(previousCwd);
      restoreEnv(previous);
      rmSync(tmp, { recursive: true, force: true });
    });
    mkdirSync(path.join(caller, "tools"), { recursive: true });
    mkdirSync(path.join(repo, "tools"));
    const trustedBin = path.join(caller, "tools/codex");
    const untrustedBin = path.join(repo, "tools/codex");
    writeFileSync(trustedBin, ["#!/bin/sh", "cat > /dev/null", "echo trusted-caller", "pwd"].join("\n"));
    writeFileSync(untrustedBin, ["#!/bin/sh", `touch ${JSON.stringify(attackMarker)}`, "echo untrusted-pr"].join("\n"));
    chmodSync(trustedBin, 0o755);
    chmodSync(untrustedBin, 0o755);
    commitAll(repo, "untrusted tracked executable");
    process.chdir(caller);
    process.env[{ codex: "CODEX_BIN", grok: "GROK_BIN", claude: "CLAUDE_BIN" }[runner]] = "./tools/codex";
    const detected = resolveRunnerBinary(runner);
    assert.equal(realpathSync(detected?.path ?? ""), realpathSync(trustedBin));
    const output = await runCodex("prompt", { runner, repoPath: repo, targetHeadSha: headSha(repo), timeoutMs: 1000 });
    const [source, cwd] = output.trim().split("\n");
    assert.equal(source, "trusted-caller");
    assert.equal(path.basename(cwd ?? ""), runner === "claude" ? "runner-repo" : "runner-launch");
    assert.equal(existsSync(attackMarker), false);
  });
}

test("Caller command resolution accepts Windows separators and preserves PATH commands", () => {
  for (const command of ["./tools/codex", "tools/codex", String.raw`.\tools\codex`]) {
    assert.equal(resolveCallerCommand(command, String.raw`C:\trusted`, path.win32), String.raw`C:\trusted\tools\codex`);
  }
  for (const command of [String.raw`C:\tools\codex.exe`, "C:/tools/codex.exe", String.raw`\\server\tools\codex.exe`, "codex"]) {
    assert.equal(resolveCallerCommand(command, String.raw`C:\trusted`, path.win32), command);
  }
  assert.equal(resolveCallerCommand("./tools/codex", "/trusted", path.posix), "/trusted/tools/codex");
  assert.equal(resolveCallerCommand("codex", "/trusted", path.posix), "codex");
});
