import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUntrackedPatch, joinSections } from "../adapters/local-uncommitted";
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
