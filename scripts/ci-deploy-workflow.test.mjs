import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const ci = readFileSync(".github/workflows/ci.yml", "utf8");
const deploy = readFileSync(".github/workflows/deploy.yml", "utf8");
const weekly = readFileSync(".github/workflows/weekly-eval.yml", "utf8");

function workflowScript(workflow, stepName) {
  const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const step = workflow.match(
    new RegExp(`      - name: ${escapedName}\\n([\\s\\S]*?)(?=\\n      - name:|$)`),
  );
  assert.ok(step, `${stepName} step must exist`);
  const runBlock = step[1].match(/        run: \|\n([\s\S]*)/);
  assert.ok(runBlock, `${stepName} must have a run block`);
  return runBlock[1]
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n");
}

const resolveScript = workflowScript(deploy, "Resolve deploy SHA");
const deployScript = workflowScript(deploy, "Deploy verified SHA");
const weeklyEvalScript = workflowScript(weekly, "Run full eval");
const verifiedSha = "a".repeat(40);
const laterSha = "b".repeat(40);

function runResolve({
  eventName = "workflow_run",
  workflowSha = verifiedSha,
  dispatchSha = laterSha,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "needlefish-ci-resolve-"));
  const githubOutput = join(root, "github-output");
  const result = spawnSync("bash", ["-c", resolveScript], {
    encoding: "utf8",
    env: {
      ...process.env,
      EVENT_NAME: eventName,
      WORKFLOW_SHA: workflowSha,
      DISPATCH_SHA: dispatchSha,
      GITHUB_OUTPUT: githubOutput,
    },
  });
  const output = {
    ...result,
    githubOutput: existsSync(githubOutput) ? readFileSync(githubOutput, "utf8") : "",
  };
  rmSync(root, { recursive: true, force: true });
  return output;
}

function runDeploy({
  eventName = "workflow_run",
  needlefishRef = verifiedSha,
  mainTip = verifiedSha,
  lsRemoteFails = false,
  unreleased = false,
  missingChangelog = false,
  forceDeploy = false,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "needlefish-ci-deploy-"));
  const fakeBin = join(root, "fake-bin");
  const scriptsDir = join(root, "scripts");
  const deployLog = join(root, "deploy.log");
  mkdirSync(fakeBin);
  mkdirSync(scriptsDir);
  writeFileSync(join(root, "package.json"), '{"version":"0.4.2"}\n');
  if (!missingChangelog) {
    writeFileSync(
      join(root, "CHANGELOG.md"),
      unreleased ? "## 0.4.2 — Unreleased\n" : "## 0.4.2 — 2026-09-01\n",
    );
  }
  writeFileSync(
    join(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "ls-remote" ] && [ "\${2:-}" = "--heads" ] && [ "\${3:-}" = "origin" ] && [ "\${4:-}" = "main" ]; then
  if [ "\${LS_REMOTE_FAIL:-}" = "1" ]; then exit 1; fi
  if [ -n "\${FAKE_MAIN_TIP:-}" ]; then printf '%s\\trefs/heads/main\\n' "$FAKE_MAIN_TIP"; fi
  exit 0
fi
exit 64
`,
  );
  chmodSync(join(fakeBin, "git"), 0o755);
  writeFileSync(
    join(scriptsDir, "deploy-ubuntu.sh"),
    `#!/bin/sh
printf 'deployed:%s\\n' "$NEEDLEFISH_REF" > "$DEPLOY_LOG"
`,
  );
  chmodSync(join(scriptsDir, "deploy-ubuntu.sh"), 0o755);

  const result = spawnSync("bash", ["-c", deployScript], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      DEPLOY_LOG: deployLog,
      EVENT_NAME: eventName,
      FORCE_DEPLOY: forceDeploy ? "true" : "false",
      FAKE_MAIN_TIP: mainTip,
      LS_REMOTE_FAIL: lsRemoteFails ? "1" : "",
      NEEDLEFISH_REF: needlefishRef,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    },
  });
  const output = {
    ...result,
    deployLog: existsSync(deployLog) ? readFileSync(deployLog, "utf8") : "",
  };
  rmSync(root, { recursive: true, force: true });
  return output;
}

test("ci runs the full frozen suite on ubuntu-latest without secrets or self-hosted", () => {
  assert.match(ci, /^name: needlefish-ci$/m);
  assert.match(ci, /^  needlefish-ci:$/m);
  assert.match(ci, /^    name: needlefish-ci$/m);
  assert.match(ci, /^  pull_request:$/m);
  assert.match(ci, /^    branches: \[main\]$/m);
  assert.match(ci, /^    runs-on: ubuntu-latest$/m);
  assert.match(ci, /corepack enable/);
  assert.match(ci, /corepack prepare "\$PNPM_VERSION" --activate/);
  assert.match(ci, /pnpm install --frozen-lockfile/);
  assert.match(ci, /pnpm check/);
  assert.match(ci, /pnpm lint/);
  assert.match(ci, /pnpm test/);
  assert.match(ci, /node-version: 20/);
  assert.doesNotMatch(ci, /self-hosted/);
  assert.doesNotMatch(ci, /secrets\./);
  assert.doesNotMatch(ci, /pull_request_target/);
  assert.doesNotMatch(ci, /head\.repo/);
});

test("deploy is gated on a successful main-push CI run and keeps workflow_dispatch", () => {
  assert.doesNotMatch(deploy, /^  push:$/m);
  assert.match(deploy, /^  workflow_run:$/m);
  assert.match(deploy, /workflows: \[needlefish-ci\]/);
  assert.match(deploy, /^  workflow_dispatch:$/m);
  assert.match(deploy, /^      force:$/m);
  assert.match(deploy, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(deploy, /github\.event\.workflow_run\.event == 'push'/);
  assert.match(deploy, /github\.event\.workflow_run\.head_branch == 'main'/);
  assert.match(deploy, /github\.event\.workflow_run\.head_sha/);
  assert.match(deploy, /NEEDLEFISH_REF: \$\{\{ steps\.sha\.outputs\.sha \}\}/);
  assert.match(deploy, /ref: \$\{\{ steps\.sha\.outputs\.sha \}\}/);
  assert.match(deploy, /^    runs-on: self-hosted$/m);
  assert.doesNotMatch(deploy, /secrets\./);
  assert.match(weekly, /gh workflow run deploy\.yml --ref main/);
  assert.doesNotMatch(weekly, /-f force=true/);
});

test("weekly eval attests the configured Codex executable", () => {
  assert.match(weeklyEvalScript, /runner_bin="\$\{CODEX_BIN:-codex\}"/);
  assert.match(weeklyEvalScript, /--runner-version "\$\("\$runner_bin" --version\)"/);
  assert.doesNotMatch(weeklyEvalScript, /\$\(codex --version\)/);
});

test("resolve uses the workflow_run head SHA and rejects a missing or invalid SHA", () => {
  const success = runResolve();
  assert.equal(success.status, 0, success.stderr);
  assert.equal(success.githubOutput, `sha=${verifiedSha}\n`);

  const dispatch = runResolve({ eventName: "workflow_dispatch" });
  assert.equal(dispatch.status, 0, dispatch.stderr);
  assert.equal(dispatch.githubOutput, `sha=${laterSha}\n`);

  const missing = runResolve({ workflowSha: "" });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /40-character lowercase SHA/);
  assert.equal(missing.githubOutput, "");

  const invalid = runResolve({ workflowSha: "main" });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.githubOutput, "");

  const other = runResolve({ eventName: "push" });
  assert.notEqual(other.status, 0);
  assert.match(other.stderr, /unsupported event/);
});

test("automatic deploy skips when main has moved and still deploys the verified SHA when it is the tip", () => {
  const current = runDeploy();
  assert.equal(current.status, 0, current.stderr);
  assert.equal(current.deployLog, `deployed:${verifiedSha}\n`);

  const stale = runDeploy({ mainTip: laterSha });
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /Skipping deploy/);
  assert.equal(stale.deployLog, "");

  const recovery = runDeploy({ eventName: "workflow_dispatch", mainTip: laterSha });
  assert.equal(recovery.status, 0, recovery.stderr);
  assert.equal(recovery.deployLog, `deployed:${verifiedSha}\n`);

  const unreleased = runDeploy({ unreleased: true });
  assert.equal(unreleased.status, 0, unreleased.stderr);
  assert.match(unreleased.stdout, /Skipping deploy of unreleased version 0\.4\.2/);
  assert.equal(unreleased.deployLog, "");

  const manualUnreleased = runDeploy({ eventName: "workflow_dispatch", unreleased: true });
  assert.equal(manualUnreleased.status, 0, manualUnreleased.stderr);
  assert.equal(manualUnreleased.deployLog, "");

  const forcedUnreleased = runDeploy({
    eventName: "workflow_dispatch",
    unreleased: true,
    forceDeploy: true,
  });
  assert.equal(forcedUnreleased.status, 0, forcedUnreleased.stderr);
  assert.equal(forcedUnreleased.deployLog, `deployed:${verifiedSha}\n`);

  const missingChangelog = runDeploy({ missingChangelog: true });
  assert.notEqual(missingChangelog.status, 0);
  assert.match(missingChangelog.stderr, /could not verify release state/);
  assert.equal(missingChangelog.deployLog, "");

  const missingTip = runDeploy({ mainTip: "" });
  assert.notEqual(missingTip.status, 0);
  assert.match(missingTip.stderr, /could not resolve origin\/main/);
  assert.equal(missingTip.deployLog, "");

  const lsRemoteFail = runDeploy({ lsRemoteFails: true });
  assert.notEqual(lsRemoteFail.status, 0);
  assert.equal(lsRemoteFail.deployLog, "");

  const invalidRef = runDeploy({ needlefishRef: "main" });
  assert.notEqual(invalidRef.status, 0);
  assert.match(invalidRef.stderr, /40-character lowercase commit SHA/);
  assert.equal(invalidRef.deployLog, "");
});
