import assert from "node:assert/strict";
import { parse } from "yaml";

// Test-only: decode the run scalar as YAML, without executing or interpolating it.
export function workflowRun(source, jobId, stepName) {
  const workflow = parse(source);
  const steps = workflow?.jobs?.[jobId]?.steps;
  assert.ok(Array.isArray(steps), `${jobId} must have steps`);
  const matches = steps.filter((step) => step?.name === stepName);
  assert.equal(
    matches.length,
    1,
    `${jobId}: expected exactly one step named ${stepName}`,
  );
  const run = matches[0].run;
  assert.ok(
    typeof run === "string" && run.trim().length > 0,
    `${jobId}: ${stepName} must have a non-empty run script`,
  );
  return run;
}
