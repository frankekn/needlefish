import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const source = readFileSync(".github/workflows/deploy.yml", "utf8");
const workflow = parse(source);

test("upstream pushes and CI completions cannot deploy over an operator installation", () => {
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.deploy["runs-on"], ["self-hosted", "Linux", "X64"]);
  assert.doesNotMatch(source, /deploy-ubuntu|git fetch|git clone|actions\/checkout|NEEDLEFISH_REF/);
});

test("manual installation check fails when the operator has not installed a release", t => {
  const home = mkdtempSync(join(tmpdir(), "needlefish-missing-self-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const result = spawnSync("bash", ["-c", workflow.jobs.deploy.steps[0].run], {
    encoding: "utf8", env: { ...process.env, HOME: home }, timeout: 5000,
  });
  assert.notEqual(result.status, 0);
});

test("manual review delegates to the local workflow and supports reconciliation input", () => {
  const manual = parse(readFileSync(".github/workflows/hosted-review.yml", "utf8"));
  assert.equal(manual.jobs.review.uses, "./.github/workflows/review.yml");
  assert.equal(manual.jobs.review.with.model, "gpt-5.6-terra");
  assert.equal(manual.jobs.review.with.codex_reasoning_effort, "xhigh");
  assert.equal(manual.on.workflow_dispatch.inputs.pr.required, false);
  assert.equal(manual.on.workflow_dispatch.inputs.pr_number.required, false);
  assert.match(manual.jobs.review.with.pr_number, /inputs.pr_number \|\| inputs.pr/);
});
