import assert from "node:assert/strict";
import test from "node:test";
import { MEASUREMENT_MAX_BYTES, measurementPipeline, measurementRuntime, measurementText, measurementWorkflow, newMeasurement, parseMeasurement, type MeasurementV1 } from "./github-measurement.js";
import { runtimeLabel, type ReviewRuntime } from "../shared/runtime.js";

function receipt(): MeasurementV1 {
  return newMeasurement({ repository: "org/repo", prNumber: 7, targetHeadSha: "a".repeat(40), workflow: measurementWorkflow({ runId: "10", runAttempt: "2", jobKey: "review" }) });
}

test("measurement round trips with explicit unknowns and a per-invocation UUID", () => {
  const record = receipt();
  assert.deepEqual(parseMeasurement(JSON.stringify(record)), record);
  assert.deepEqual(record.execution, { ordinal: 1, role: "unknown" });
  assert.deepEqual(record.runtime, { status: "unknown" });
  assert.deepEqual(record.pipeline, { status: "unknown" });
  assert.notEqual(receipt().invocationId, record.invocationId);
});

test("runtime projection preserves public provenance and excludes all private identity fields", () => {
  const runtime: ReviewRuntime = {
    runner: "codex", model: { status: "operator_attested", value: "org/model" }, effort: { status: "known", value: "high" },
    coreVersion: { status: "known", value: "0.4.10" }, sourceSha: { status: "known", value: "private-sha" },
    runnerVersion: { status: "unknown" }, launcherDigest: { status: "known", value: "private-digest" }, promptHash: { status: "known", value: "private-prompt" },
    callTimeoutMs: 120000, reviewBudgetMs: null, qualification: { matchStatus: "unqualified" },
  };
  assert.deepEqual(measurementRuntime(runtime), {
    status: "recorded", runner: "codex", model: { status: "operator_attested", value: "org/model" },
    effort: { status: "known", value: "high" }, coreVersion: { status: "known", value: "0.4.10" }, qualification: { matchStatus: "unqualified" },
  });
  assert.deepEqual(measurementRuntime(undefined), { status: "unknown" });
  const record = { ...receipt(), runtime: measurementRuntime(runtime) };
  assert.deepEqual(parseMeasurement(JSON.stringify(record)), record);
});

test("pipeline capture never subtracts a missing or reversed clock", () => {
  assert.deepEqual(measurementPipeline(100.25, 125.75), { status: "observed", clock: "producer_monotonic", elapsedMs: 25.5 });
  for (const [start, end] of [[null, 10], [10, 9], [NaN, 10], [1, Infinity]]) assert.deepEqual(measurementPipeline(start, end ?? 0), { status: "unknown" });
});

test("workflow identity requires the captured run, attempt and job without inferring role", () => {
  assert.deepEqual(measurementWorkflow({ runId: "10", runAttempt: "2", jobKey: "review" }), { status: "recorded", runId: "10", runAttempt: 2, jobKey: "review" });
  for (const input of [
    { runId: "10", runAttempt: undefined, jobKey: "review" },
    { runId: "10", runAttempt: "0", jobKey: "review" },
    { runId: "1e5", runAttempt: "2", jobKey: "review" },
    { runId: "10", runAttempt: "2", jobKey: "private/path" },
  ]) assert.deepEqual(measurementWorkflow(input), { status: "unknown" });
});

test("wire boundary rejects extra fields, qualification and inconsistent delivery", () => {
  const record = receipt();
  for (const invalid of [
    { ...record, credential: "fake-private" }, { ...record, schemaVersion: 2 },
    { ...record, execution: { ordinal: 1, role: "fallback" } },
    { ...record, delivery: "delivered" }, { ...record, outcome: "verdict" },
    { ...record, runtime: { status: "recorded", runner: "codex", model: { status: "unknown" }, effort: { status: "unknown" }, coreVersion: { status: "unknown" }, qualification: { matchStatus: "qualified" } } },
    { ...record, pipeline: { status: "observed", elapsedMs: -1, clock: "producer_monotonic" } },
    { ...record, inlineReviewIds: [1, 1] }, { ...record, summaryReviewId: "1" },
  ]) assert.throws(() => parseMeasurement(JSON.stringify(invalid)), /measurement/);
  assert.throws(() => parseMeasurement("{"), /invalid measurement JSON/);
});

test("8 KiB cap rejects the complete record without producing truncated JSON", () => {
  const record = receipt();
  const empty = JSON.stringify({ ...record, repository: "" });
  const atLimit = { ...record, repository: "a".repeat(MEASUREMENT_MAX_BYTES - Buffer.byteLength(empty)) };
  const text = measurementText(atLimit);
  assert.equal(Buffer.byteLength(text ?? ""), MEASUREMENT_MAX_BYTES);
  assert.equal(JSON.parse(text ?? "").repository, atLimit.repository);
  assert.equal(measurementText({ ...atLimit, repository: `${atLimit.repository}é` }), undefined);
  assert.throws(() => parseMeasurement(`${text} `), /measurement exceeds byte limit/);
});

test("measurement runtime parsing uses the public identity privacy contract", () => {
  for (const value of ["https://private.invalid/key", "/Users/alice/private", "space value", "sk-" + "a".repeat(48)]) {
    const runtime = { status: "recorded", runner: "codex", model: { status: "known", value }, effort: { status: "known", value }, coreVersion: { status: "known", value }, qualification: { matchStatus: "unqualified" } };
    const parsed = parseMeasurement(JSON.stringify({ ...receipt(), runtime })).runtime;
    assert.equal(parsed.status, "recorded");
    if (parsed.status === "recorded") {
      assert.deepEqual(parsed.model, runtimeLabel(value, "known", "model"));
      assert.deepEqual(parsed.effort, runtimeLabel(value));
      assert.deepEqual(parsed.coreVersion, runtimeLabel(value));
    }
  }
  const runtime = { status: "recorded", runner: "codex", model: { status: "operator_attested", value: "org/model@revision" }, effort: { status: "known", value: "high" }, coreVersion: { status: "known", value: "0.4.10" }, qualification: { matchStatus: "unqualified" } };
  assert.deepEqual(parseMeasurement(JSON.stringify({ ...receipt(), runtime })).runtime, runtime);
});
