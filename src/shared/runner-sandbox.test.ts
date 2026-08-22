import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUntrackedPatch, joinSections } from "../adapters/local-uncommitted";
import { commitAll, headSha, initRepo } from "./codex-runner-test-fixtures";
import {
  assertRunnerSandboxClean,
  isRunnerSafetyError,
  prepareRunnerSandbox,
} from "./runner-sandbox";

test("prepareRunnerSandbox applies WORKING patch without trailing newline", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-sandbox-test-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repoRoot = path.join(tmp, "source");
  const sandboxTmp = path.join(tmp, "sandbox");
  mkdirSync(repoRoot);
  mkdirSync(sandboxTmp);
  const repo = initRepo(repoRoot);
  const changedContent = "fixture\nmodified in working tree\n";
  writeFileSync(path.join(repo, "README.md"), changedContent);
  const patch = execFileSync("git", ["diff", "--", "README.md"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.ok(patch.endsWith("\n"));
  const strippedPatch = patch.slice(0, -1);
  assert.ok(!strippedPatch.endsWith("\n"));

  const sandbox = prepareRunnerSandbox({
    runner: "claude",
    repoPath: repo,
    prompt: "",
    targetHeadSha: "WORKING",
    targetPatch: strippedPatch,
    tmp: sandboxTmp,
  });

  assert.equal(sandbox.expectedHeadSha, headSha(sandbox.repoPath));
  assert.equal(readFileSync(path.join(sandbox.repoPath, "README.md"), "utf8"), changedContent);
  assert.equal(
    execFileSync("git", ["show", "HEAD:README.md"], {
      cwd: sandbox.repoPath,
      encoding: "utf8",
    }),
    changedContent
  );
});

test("prepareRunnerSandbox applies WORKING patch with trailing newline", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-sandbox-test-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repoRoot = path.join(tmp, "source");
  const sandboxTmp = path.join(tmp, "sandbox");
  mkdirSync(repoRoot);
  mkdirSync(sandboxTmp);
  const repo = initRepo(repoRoot);
  const changedContent = "fixture\nmodified in working tree\n";
  writeFileSync(path.join(repo, "README.md"), changedContent);
  const patch = execFileSync("git", ["diff", "--", "README.md"], {
    cwd: repo,
    encoding: "utf8",
  });
  assert.ok(patch.endsWith("\n"));

  const sandbox = prepareRunnerSandbox({
    runner: "claude",
    repoPath: repo,
    prompt: "",
    targetHeadSha: "WORKING",
    targetPatch: patch,
    tmp: sandboxTmp,
  });

  assert.equal(sandbox.expectedHeadSha, headSha(sandbox.repoPath));
  assert.equal(readFileSync(path.join(sandbox.repoPath, "README.md"), "utf8"), changedContent);
  assert.equal(
    execFileSync("git", ["show", "HEAD:README.md"], {
      cwd: sandbox.repoPath,
      encoding: "utf8",
    }),
    changedContent
  );
});

test("prepareRunnerSandbox WORKING applies CJK tracked + untracked (no final newline)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-sandbox-cjk-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repoRoot = path.join(tmp, "source");
  const sandboxTmp = path.join(tmp, "sandbox");
  mkdirSync(repoRoot);
  mkdirSync(sandboxTmp);
  const repo = initRepo(repoRoot);

  const trackedContent = "fixture\n回傳值必須是加法結果\n";
  writeFileSync(path.join(repo, "README.md"), trackedContent);

  const untrackedPath = "src/cjk-new.ts";
  mkdirSync(path.join(repo, "src"));
  // No trailing newline on the last line — hand-built hunks historically corrupted this.
  const untrackedContent = Buffer.from("export const msg = \"你好\";\n// 回傳值必須是加法結果", "utf8");
  assert.ok(!untrackedContent.toString("utf8").endsWith("\n"));
  writeFileSync(path.join(repo, untrackedPath), untrackedContent);

  const trackedPatch = execFileSync("git", ["diff", "HEAD", "--", "README.md"], {
    cwd: repo,
    encoding: "utf8",
  });
  const untracked = buildUntrackedPatch(repo, [untrackedPath]);
  assert.deepEqual(untracked.paths, [untrackedPath]);
  assert.equal(untracked.skipped.length, 0);

  // Untracked hunks must be real `git diff --no-index` output (not hand-built).
  const realUntracked = spawnSync(
    "git",
    ["diff", "--no-index", "--no-color", "--", "/dev/null", untrackedPath],
    { cwd: repo, encoding: "utf8" }
  );
  assert.equal(realUntracked.status, 1);
  assert.ok((realUntracked.stdout ?? "").length > 0);
  assert.equal(untracked.patch, realUntracked.stdout);

  const patch = joinSections([trackedPatch, untracked.patch]);
  const sandbox = prepareRunnerSandbox({
    runner: "claude",
    repoPath: repo,
    prompt: "",
    targetHeadSha: "WORKING",
    targetPatch: patch,
    tmp: sandboxTmp,
  });

  assert.equal(sandbox.expectedHeadSha, headSha(sandbox.repoPath));
  assert.equal(readFileSync(path.join(sandbox.repoPath, "README.md"), "utf8"), trackedContent);
  assert.deepEqual(readFileSync(path.join(sandbox.repoPath, untrackedPath)), untrackedContent);
});

function makeShaSandbox(
  t: { after: (fn: () => void) => void },
  setup?: (repo: string) => void
): { tmp: string; sandbox: ReturnType<typeof prepareRunnerSandbox> } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-sandbox-sec-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repoRoot = path.join(tmp, "source");
  const sandboxTmp = path.join(tmp, "sandbox");
  mkdirSync(repoRoot);
  mkdirSync(sandboxTmp);
  const repo = initRepo(repoRoot);
  setup?.(repo);
  const sandbox = prepareRunnerSandbox({
    runner: "claude",
    repoPath: repo,
    prompt: "",
    targetHeadSha: headSha(repo),
    tmp: sandboxTmp,
  });
  return { tmp, sandbox };
}

function writeFsmonitor(tmp: string): { scriptPath: string; sentinelPath: string } {
  const sentinelPath = path.join(tmp, "fsmonitor.sentinel");
  const scriptPath = path.join(tmp, "fsmonitor.sh");
  writeFileSync(
    scriptPath,
    `#!/bin/sh
printf '%s\\n' ran >${JSON.stringify(sentinelPath)}
printf 'PARENT_ONLY=%s\\n' "\${NEEDLEFISH_PARENT_ONLY-unset}" >>${JSON.stringify(sentinelPath)}
exit 0
`
  );
  chmodSync(scriptPath, 0o755);
  return { scriptPath, sentinelPath };
}

function restoreEnv(t: { after: (fn: () => void) => void }, name: string): void {
  const previous = process.env[name];
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
}

test("assertRunnerSandboxClean does not execute a sandbox core.fsmonitor program", (t) => {
  const { tmp, sandbox } = makeShaSandbox(t);
  restoreEnv(t, "NEEDLEFISH_PARENT_ONLY");
  process.env.NEEDLEFISH_PARENT_ONLY = "parent-secret";
  const { scriptPath, sentinelPath } = writeFsmonitor(tmp);
  execFileSync("git", ["config", "core.fsmonitor", scriptPath], {
    cwd: sandbox.repoPath,
    encoding: "utf8",
  });

  try {
    assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);
  } catch (error) {
    assert.equal(isRunnerSafetyError(error), true);
  }
  assert.equal(existsSync(sentinelPath), false);
});

test("assertRunnerSandboxClean does not execute fsmonitor from HOME gitconfig", (t) => {
  const { tmp, sandbox } = makeShaSandbox(t);
  restoreEnv(t, "HOME");
  restoreEnv(t, "NEEDLEFISH_PARENT_ONLY");
  process.env.NEEDLEFISH_PARENT_ONLY = "parent-secret";
  const { scriptPath, sentinelPath } = writeFsmonitor(tmp);
  const hostileHome = path.join(tmp, "hostile-home");
  mkdirSync(hostileHome);
  writeFileSync(path.join(hostileHome, ".gitconfig"), `[core]\n\tfsmonitor = ${scriptPath}\n`);
  process.env.HOME = hostileHome;

  assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);
  assert.equal(existsSync(sentinelPath), false);
});

test("assertRunnerSandboxClean does not honor parent GIT_CONFIG_SYSTEM", (t) => {
  const { tmp, sandbox } = makeShaSandbox(t);
  restoreEnv(t, "GIT_CONFIG_SYSTEM");
  restoreEnv(t, "NEEDLEFISH_PARENT_ONLY");
  process.env.NEEDLEFISH_PARENT_ONLY = "parent-secret";
  const { scriptPath, sentinelPath } = writeFsmonitor(tmp);
  const systemConfig = path.join(tmp, "system.gitconfig");
  writeFileSync(systemConfig, `[core]\n\tfsmonitor = ${scriptPath}\n`);
  process.env.GIT_CONFIG_SYSTEM = systemConfig;

  assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);
  assert.equal(existsSync(sentinelPath), false);
});

test("assertRunnerSandboxClean rejects a dirty worktree", (t) => {
  const { sandbox } = makeShaSandbox(t);
  writeFileSync(path.join(sandbox.repoPath, "pwned.txt"), "dirty\n");
  assert.throws(
    () => assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha),
    (error: unknown) => {
      assert.equal(isRunnerSafetyError(error), true);
      assert.match((error as Error).message, /pwned\.txt/);
      return true;
    }
  );
});

test("assertRunnerSandboxClean rejects a moved HEAD", (t) => {
  const { sandbox } = makeShaSandbox(t);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Needlefish Test",
      "-c",
      "user.email=needlefish-test@example.invalid",
      "commit",
      "--allow-empty",
      "-m",
      "move-head",
    ],
    { cwd: sandbox.repoPath, encoding: "utf8" }
  );
  const newHead = headSha(sandbox.repoPath);
  assert.notEqual(newHead, sandbox.expectedHeadSha);
  assert.throws(
    () => assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha),
    (error: unknown) => {
      assert.equal(isRunnerSafetyError(error), true);
      assert.match((error as Error).message, new RegExp(`HEAD moved to ${newHead}`));
      return true;
    }
  );
});

test("assertRunnerSandboxClean preserves ignored and untracked handling", (t) => {
  const { sandbox } = makeShaSandbox(t, (repo) => {
    writeFileSync(path.join(repo, ".gitignore"), "*.ignored\n");
    commitAll(repo, "ignore patterns");
  });

  mkdirSync(path.join(sandbox.repoPath, ".codegraph"));
  writeFileSync(path.join(sandbox.repoPath, ".codegraph", "cache"), "ok\n");
  assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);

  writeFileSync(path.join(sandbox.repoPath, "foo.ignored"), "hidden?\n");
  assert.throws(
    () => assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha),
    (error: unknown) => {
      assert.equal(isRunnerSafetyError(error), true);
      assert.match((error as Error).message, /foo\.ignored/);
      return true;
    }
  );
});

test("assertRunnerSandboxClean rejects security-relevant .git metadata changes", (t) => {
  const { sandbox } = makeShaSandbox(t);
  execFileSync("git", ["config", "user.needlefish", "pwned"], {
    cwd: sandbox.repoPath,
    encoding: "utf8",
  });
  assert.throws(
    () => assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha),
    (error: unknown) => {
      assert.equal(isRunnerSafetyError(error), true);
      assert.match((error as Error).message, /\.git\/config or hooks changed/);
      return true;
    }
  );
});
