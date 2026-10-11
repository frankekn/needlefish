import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildUntrackedPatch } from "../adapters/local-uncommitted.js";
import { commitAll, gitText, headSha, initRepo } from "./codex-runner-test-fixtures.js";
import { prepareRunnerSandbox, assertRunnerSandboxClean } from "./runner-sandbox.js";

for (const unborn of [false, true]) {
  test(`working review refs expose the exact diff (${unborn ? "unborn" : "committed"} baseline)`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-refs-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const repo = unborn ? path.join(tmp, "source") : initRepo(tmp);
    if (unborn) {
      mkdirSync(repo);
      gitText(["init", "--quiet"], repo);
    }
    const base = unborn ? "EMPTY" : headSha(repo);
    const content = "export const value = 2;\n";
    if (!unborn) gitText(["tag", "WORKING"], repo);
    writeFileSync(path.join(repo, "app.ts"), content);
    const patch = buildUntrackedPatch(repo, ["app.ts"]).patch;
    if (unborn) commitAll(repo, "source committed after capture");
    const sandboxTmp = path.join(tmp, "sandbox");
    mkdirSync(sandboxTmp);
    const sandbox = prepareRunnerSandbox({
      runner: "claude", repoPath: repo, targetHeadSha: "WORKING",
      targetBaseSha: base, targetPatch: patch, prompt: `BASE: ${base}\nHEAD: WORKING`, tmp: sandboxTmp,
    });
    assert.match(gitText(["diff", `${base}..WORKING`, "--", "app.ts"], sandbox.repoPath), /\+export const value = 2;/);
    assert.equal(gitText(["show", "WORKING:app.ts"], sandbox.repoPath), content.trim());
    assert.equal(gitText(["rev-parse", "WORKING"], sandbox.repoPath), sandbox.expectedHeadSha);
    assert.equal(gitText(["ls-tree", base, "--", "app.ts"], sandbox.repoPath), "");
    assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);
    assert.equal(gitText(["status", "--porcelain"], repo), unborn ? "" : "?? app.ts");
  });
}

test("working sandbox uses the captured baseline when source HEAD moves", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-baseline-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  const base = headSha(repo);
  writeFileSync(path.join(repo, "README.md"), "reviewed content\n");
  const patch = gitText(["diff", "HEAD"], repo) + "\n";
  writeFileSync(path.join(repo, "README.md"), "later source commit\n");
  commitAll(repo, "source advanced");
  const sourceHead = headSha(repo);
  const sandboxTmp = path.join(tmp, "sandbox");
  mkdirSync(sandboxTmp);
  const sandbox = prepareRunnerSandbox({
    runner: "claude", repoPath: repo, targetHeadSha: "WORKING", targetBaseSha: base,
    targetPatch: patch, prompt: "probe", tmp: sandboxTmp,
  });
  assert.equal(gitText(["show", "WORKING:README.md"], sandbox.repoPath), "reviewed content");
  assert.equal(gitText(["rev-parse", "WORKING^"], sandbox.repoPath), base);
  assert.equal(headSha(repo), sourceHead);
});
