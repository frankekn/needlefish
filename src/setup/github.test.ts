import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { GITHUB_WORKFLOW, planGithubSetup, renderGithubSetup } from "./github.js";

function repo(t: TestContext, name = "target"): string {
  const parent = mkdtempSync(join(tmpdir(), "needlefish-setup-"));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const root = join(parent, name);
  mkdirSync(root);
  const init = spawnSync("git", ["init", "-q", root], { encoding: "utf8" });
  assert.equal(init.status, 0, init.stderr);
  return root;
}

function workflowPath(root: string): string {
  return join(realpathSync(root), ".github", "workflows", "needlefish.yml");
}

test("setup previews one pinned hosted workflow without writing to the repository", (t) => {
  const root = repo(t);
  const plan = planGithubSetup(root);
  assert.equal(plan.kind, "create");
  assert.equal(plan.path, workflowPath(root));
  assert.throws(() => readFileSync(plan.path), /ENOENT/);
  assert.match(renderGithubSetup(plan), /preview only.*No credential was configured, no PR was created, and no review was completed/);

  const yaml = YAML.parseDocument(plan.proposed);
  assert.deepEqual(yaml.errors, []);
  const triggers = yaml.getIn(["on", "pull_request", "types"], true);
  assert.ok(YAML.isSeq(triggers));
  assert.deepEqual(triggers.toJSON(), ["opened", "reopened", "synchronize", "ready_for_review"]);
  assert.equal(yaml.getIn(["on", "pull_request_target"]), undefined);
  assert.deepEqual(yaml.getIn(["permissions", "contents"]), "read");
  assert.deepEqual(yaml.getIn(["permissions", "pull-requests"]), "write");
  assert.deepEqual(yaml.getIn(["permissions", "checks"]), "write");
  assert.equal(yaml.getIn(["jobs", "review", "runs-on"]), "ubuntu-latest");
  assert.equal(yaml.getIn(["jobs", "review", "timeout-minutes"]), 35);
  assert.equal(yaml.getIn(["jobs", "review", "steps", 2, "uses"]), "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 2, "with", "persist-credentials"]), false);
  assert.equal(yaml.getIn(["jobs", "review", "steps", 2, "with", "ref"]), "${{ github.event.pull_request.head.sha }}");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 3, "uses"]), "frankekn/needlefish@7e5c4738eeac71c87be1766b3bb30fb82fc4706f");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 3, "with", "runner_version"]), "0.163.0");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 3, "with", "model"]), "gpt-5.6-terra");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 3, "with", "codex_reasoning_effort"]), "high");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 3, "env", "CODEX_API_KEY"]), "${{ secrets.NEEDLEFISH_CODEX_API_KEY }}");
  assert.equal(yaml.getIn(["jobs", "review", "steps", 3, "env", "NEEDLEFISH_REVIEW_TIMEOUT_MS"]), "1800000");
});

test("the workflow fails closed before checkout for fork, bot, and untrusted authors", () => {
  const yaml = YAML.parseDocument(GITHUB_WORKFLOW);
  const guard = yaml.getIn(["jobs", "review", "steps", 0, "run"]);
  assert.equal(typeof guard, "string");
  const run = (head: string, association: string, type: string) => spawnSync("bash", ["-e"], {
    input: String(guard),
    encoding: "utf8",
    env: { TARGET_REPO: "owner/repo", HEAD_REPO: head, AUTHOR_ASSOCIATION: association, AUTHOR_TYPE: type },
  });
  assert.equal(run("owner/repo", "MEMBER", "User").status, 0);
  for (const [head, association, type] of [
    ["other/repo", "MEMBER", "User"],
    ["owner/repo", "NONE", "User"],
    ["owner/repo", "OWNER", "Bot"],
    ["owner/repo; touch /tmp/needlefish-injected", "MEMBER", "User"],
  ]) {
    const result = run(head, association, type);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /has not reviewed this PR/);
  }
  const credentialGuard = yaml.getIn(["jobs", "review", "steps", 1, "run"]);
  assert.equal(typeof credentialGuard, "string");
  const missing = spawnSync("bash", ["-e"], { input: String(credentialGuard), encoding: "utf8", env: { CODEX_API_KEY: "" } });
  assert.equal(missing.status, 1);
  assert.match(missing.stdout, /Set repository secret NEEDLEFISH_CODEX_API_KEY/);
});

test("setup is repeatable and previews edits to its own workflow", (t) => {
  const root = repo(t);
  const path = workflowPath(root);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  writeFileSync(path, GITHUB_WORKFLOW);
  assert.equal(planGithubSetup(root).kind, "unchanged");
  const edited = GITHUB_WORKFLOW.replace("timeout-minutes: 35", "timeout-minutes: 50");
  writeFileSync(path, edited);
  const plan = planGithubSetup(root);
  assert.equal(plan.kind, "update");
  assert.match(renderGithubSetup(plan), /- {4}timeout-minutes: 50\n\+ {4}timeout-minutes: 35/);
  assert.equal(readFileSync(path, "utf8"), edited);
});

test("setup preserves custom workflows and refuses duplicate installs", (t) => {
  const root = repo(t);
  const workflows = join(root, ".github", "workflows");
  mkdirSync(workflows, { recursive: true });
  const custom = join(workflows, "my-review.yaml");
  writeFileSync(custom, "jobs:\n  review:\n    steps:\n      - uses: frankekn/needlefish@v0\n");
  const duplicate = planGithubSetup(root);
  assert.equal(duplicate.kind, "conflict");
  assert.match(renderGithubSetup(duplicate), /already configures Needlefish/);
  assert.equal(readFileSync(custom, "utf8"), "jobs:\n  review:\n    steps:\n      - uses: frankekn/needlefish@v0\n");
  rmSync(custom);
  writeFileSync(custom, "name: My Needlefish review\n");
  assert.equal(planGithubSetup(root).kind, "create");
  writeFileSync(custom, "name: My Needlefish review\nrun: needlefish --github --pr 1\n");
  assert.equal(planGithubSetup(root).kind, "conflict");
  rmSync(custom);
  writeFileSync(workflowPath(root), "name: my own review\n");
  assert.match(renderGithubSetup(planGithubSetup(root)), /is not managed by Needlefish setup/);
  rmSync(workflowPath(root));
  symlinkSync(join(root, "missing"), workflowPath(root));
  assert.match(renderGithubSetup(planGithubSetup(root)), /is not a regular file/);
});

test("repository names are data, and setup rejects directories outside Git", (t) => {
  const root = repo(t, "repo;$(touch never)");
  assert.equal(planGithubSetup(root).kind, "create");
  const outside = mkdtempSync(join(tmpdir(), "needlefish-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  assert.throws(() => planGithubSetup(outside), /not a Git repository/);
});

test("the CLI previews without side effects and returns a nonzero status for conflicts", (t) => {
  const root = repo(t, "repo;$(touch never)");
  const checkout = fileURLToPath(new URL("../../", import.meta.url));
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const hook = join(dirname(root), "diff-hook");
  const marker = join(root, "diff-executed");
  writeFileSync(hook, '#!/bin/sh\nprintf called > "$NF_SETUP_DIFF_MARKER"\n', { mode: 0o755 });
  const run = () => spawnSync(process.execPath, ["--import", "tsx", cli, "setup", "github", "--repo", root], {
    cwd: checkout,
    encoding: "utf8",
    env: { ...process.env, CODEX_API_KEY: "secret-sentinel", GIT_EXTERNAL_DIFF: hook, NF_SETUP_DIFF_MARKER: marker },
  });
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Plan: create[\s\S]*Proposed workflow:/);
  assert.doesNotMatch(first.stdout, /secret-sentinel/);
  assert.throws(() => readFileSync(workflowPath(root)), /ENOENT/);
  mkdirSync(join(root, ".github", "workflows"), { recursive: true });
  const edited = GITHUB_WORKFLOW.replace("timeout-minutes: 35", "timeout-minutes: 50");
  writeFileSync(workflowPath(root), edited);
  const update = run();
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /- {4}timeout-minutes: 50\n\+ {4}timeout-minutes: 35/);
  assert.throws(() => readFileSync(marker), /ENOENT/);
  assert.equal(readFileSync(workflowPath(root), "utf8"), edited);
  writeFileSync(workflowPath(root), "name: custom\n");
  const conflict = run();
  assert.equal(conflict.status, 1, conflict.stderr);
  assert.match(conflict.stdout, /Plan: conflict[\s\S]*not managed by Needlefish setup/);
  assert.equal(readFileSync(workflowPath(root), "utf8"), "name: custom\n");
});


test("local setup preserves repository roots with trailing whitespace", t => {
  for (const name of ["space ", "tab\t", "newline\n", "carriage\r"]) {
    const root = repo(t, name);
    assert.equal(planGithubSetup(root).path, workflowPath(root));
  }
});
