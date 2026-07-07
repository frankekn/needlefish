import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { headSha, initRepo } from "./codex-runner-test-fixtures";
import { prepareRunnerSandbox } from "./runner-sandbox";

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
