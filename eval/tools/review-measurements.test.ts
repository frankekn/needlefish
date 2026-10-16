import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { newMeasurement, measurementWorkflow, type MeasurementV1 } from "../../src/adapters/github-measurement.js";
import { collectReviewMeasurements, parseMeasurementArgs, utcDuration, type GithubRead, type MeasurementQuery } from "./review-measurements.js";

const query: MeasurementQuery = { repository: "org/repo", prNumber: 7, targetHeadSha: "a".repeat(40), workflowId: 44, workflowPath: ".github/workflows/review.yml", maxPages: 2 };
function receipt(overrides: Partial<MeasurementV1> = {}): MeasurementV1 {
  return { ...newMeasurement({ repository: query.repository, prNumber: 7, targetHeadSha: query.targetHeadSha, workflow: measurementWorkflow({ runId: "10", runAttempt: "2", jobKey: "review" }) }),
    summaryReviewId: 100, inlineReviewIds: [101], outcome: "verdict", verdict: "pass", delivery: "delivered", pipeline: { status: "observed", clock: "producer_monotonic", elapsedMs: 2500 }, ...overrides };
}
function fixture(record = receipt(), overrides: { check?: Record<string, unknown>; run?: Record<string, unknown>; job?: Record<string, unknown>; checks?: readonly Record<string, unknown>[]; jobs?: readonly Record<string, unknown>[] } = {}): { read: GithubRead; calls: string[] } {
  const check = { id: 30, name: "Needlefish", head_sha: query.targetHeadSha, status: "completed", conclusion: "success", started_at: "2026-10-16T00:00:00Z", completed_at: "2026-10-16T00:00:20Z", app: { id: 15368, slug: "github-actions" }, external_id: JSON.stringify({ v: 2, prNumber: 7, roundId: record.invocationId, runId: "10" }), output: { text: JSON.stringify(record) }, ...overrides.check };
  const run = { id: 10, run_attempt: 2, workflow_id: 44, path: query.workflowPath, repository: { full_name: query.repository }, head_sha: "b".repeat(40), created_at: "2026-10-16T00:00:00Z", ...overrides.run };
  const job = { id: 20, run_id: 10, run_attempt: 2, name: "review", status: "completed", created_at: "2026-10-16T00:00:01Z", started_at: "2026-10-16T00:00:11Z", check_run_url: "https://api.github.com/repos/org/repo/check-runs/21", ...overrides.job };
  const calls: string[] = [];
  const read = (endpoint: string): unknown => {
    calls.push(endpoint);
    if (endpoint === `repos/org/repo/commits/${query.targetHeadSha}/check-runs?check_name=Needlefish&filter=all&per_page=100&page=1`) return { total_count: overrides.checks?.length ?? 1, check_runs: overrides.checks ?? [check] };
    if (endpoint === "repos/org/repo/actions/runs/10/attempts/2") return run;
    if (endpoint === "repos/org/repo/actions/runs/10/attempts/2/jobs?per_page=100&page=1") return { total_count: overrides.jobs?.length ?? 1, jobs: overrides.jobs ?? [job] };
    throw new Error("unexpected read endpoint");
  };
  return { read, calls };
}

test("collector separates target head, merge ref, job ID and self-created check ID", () => {
  const record = receipt(); const source = fixture(record); const report = collectReviewMeasurements(query, source.read);
  assert.equal(report.partial, false); assert.deepEqual(report.diagnostics, []);
  assert.equal(report.rows.length, 1);
  const row = report.rows[0];
  assert.equal(row.measurement.targetHeadSha, query.targetHeadSha); assert.equal(row.workflowRefSha, "b".repeat(40));
  assert.equal(row.checkRunId, 30); assert.equal(row.workflowRunId, 10); assert.equal(row.runAttempt, 2);
  assert.equal(row.checkStatus, "completed"); assert.equal(row.evidenceStatus, "delivered"); assert.equal(row.workflowJobDatabaseId, 20); assert.equal(row.workflowJobCheckRunId, 21);
  assert.deepEqual(row.binding, { status: "producer_attested" });
  assert.deepEqual(row.durations, {
    pipelineMs: { status: "observed", valueMs: 2500, clock: "producer_monotonic" },
    jobQueueMs: { status: "observed", valueMs: 10000, clock: "github_utc" },
    workflowCreatedToTerminalMs: { status: "observed", valueMs: 20000, clock: "github_utc" },
    triggerToTerminalMs: { status: "unknown", reason: "missing_trusted_event_time" }, pushToTerminalMs: { status: "unknown", reason: "missing_trusted_push_time" },
  });
  assert.equal(source.calls.length, 3);
});

for (const [name, overrides, reason] of [
  ["repository", { run: { repository: { full_name: "other/repo" } } }, "workflow_binding_conflict"],
  ["run", { run: { id: 11 } }, "workflow_binding_conflict"],
  ["attempt", { run: { run_attempt: 1 } }, "workflow_binding_conflict"],
  ["workflow ID", { run: { workflow_id: 45 } }, "workflow_binding_conflict"],
  ["workflow path", { run: { path: ".github/workflows/other.yml" } }, "workflow_binding_conflict"],
  ["job attempt", { job: { run_attempt: 1 } }, "job_binding_conflict"],
  ["job run", { job: { run_id: 11 } }, "job_binding_conflict"],
  ["job name", { job: { name: "review-copy" } }, "job_binding_conflict"],
  ["job check URL", { job: { check_run_url: "https://api.github.com/repos/other/repo/check-runs/21" } }, "job_binding_conflict"],
  ["app", { check: { app: { id: 44, slug: "custom-app" } } }, "unverified_check_app"],
  ["external ID", { check: { external_id: JSON.stringify({ v: 2, prNumber: 8, runId: "10", roundId: "wrong" }) } }, "check_run_binding_conflict"],
] as const) {
  test(`collector does not bind a different ${name}`, () => {
    const report = collectReviewMeasurements(query, fixture(receipt(), overrides).read);
    assert.equal(report.partial, true); assert.deepEqual(report.rows[0].binding, { status: "unknown", reason });
    assert.equal(report.rows[0].workflowJobDatabaseId, null);
    assert.equal(report.rows[0].evidenceStatus, "unknown");
    assert.deepEqual(report.rows[0].durations.jobQueueMs, { status: "unknown", reason: "unbound_job" });
  });
}

test("queued job's prefilled started_at is not queue evidence", () => {
  const row = collectReviewMeasurements(query, fixture(receipt(), { job: { status: "queued" } }).read).rows[0];
  assert.deepEqual(row.durations.jobQueueMs, { status: "unknown", reason: "job_not_started" });
  assert.deepEqual(row.durations.workflowCreatedToTerminalMs, { status: "observed", valueMs: 20000, clock: "github_utc" });
});

test("nonterminal and missing measurements remain visible diagnostics", () => {
  const record = receipt({ delivery: "partial", outcome: "cancelled", verdict: null });
  const report = collectReviewMeasurements(query, fixture(record, { check: { status: "in_progress" } }).read);
  assert.deepEqual(report.rows[0].durations.workflowCreatedToTerminalMs, { status: "unknown", reason: "missing_timestamp" });
  assert.equal(report.rows[0].checkStatus, "in_progress"); assert.equal(report.rows[0].evidenceStatus, "partial");
  assert.deepEqual(report.diagnostics.map((item) => item.reason), ["delivery_partial", "check_not_terminal"]);
  const missing = collectReviewMeasurements(query, fixture(record, { check: { output: null, status: "in_progress" } }).read);
  assert.deepEqual(missing.rows, []); assert.deepEqual(missing.diagnostics, [{ checkRunId: 30, reason: "in_progress_missing_record" }]);
});

test("different repo, PR or head cannot become a measurement row", () => {
  for (const change of [{ repository: "other/repo" }, { prNumber: 8 }, { targetHeadSha: "c".repeat(40) }]) {
    const report = collectReviewMeasurements(query, fixture(receipt(change)).read);
    assert.deepEqual(report.rows, []); assert.deepEqual(report.diagnostics, [{ checkRunId: 30, reason: "record_envelope_conflict" }]);
  }
  const report = collectReviewMeasurements(query, fixture(receipt(), { check: { head_sha: "c".repeat(40) } }).read);
  assert.deepEqual(report.diagnostics, [{ checkRunId: 30, reason: "check_envelope_conflict" }]);
});

test("same invocation conflicts exclude every copy and byte-identical duplicates count once", () => {
  const record = receipt();
  const base = { id: 30, name: "Needlefish", head_sha: query.targetHeadSha, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" }, external_id: JSON.stringify({ v: 2, prNumber: 7, roundId: record.invocationId, runId: "10" }), output: { text: JSON.stringify(record) } };
  const duplicate = collectReviewMeasurements(query, fixture(record, { checks: [base, { ...base, id: 31 }] }).read);
  assert.equal(duplicate.rows.length, 1); assert.equal(duplicate.partial, false); assert.equal(duplicate.diagnostics[0].reason, "duplicate_record");
  const conflict = collectReviewMeasurements(query, fixture(record, { checks: [base, { ...base, id: 31, output: { text: JSON.stringify({ ...record, delivery: "partial" }) } }] }).read);
  assert.deepEqual(conflict.rows, []); assert.deepEqual(conflict.diagnostics.map((item) => item.reason), ["invocation_conflict", "invocation_conflict"]);
});

test("rechecks remain distinct and duplicate job names stay unknown", () => {
  const record = receipt(); const retry = receipt();
  const checks = [record, retry].map((value, i) => ({ id: i + 30, name: "Needlefish", head_sha: query.targetHeadSha, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" }, external_id: JSON.stringify({ v: 2, prNumber: 7, roundId: value.invocationId, runId: "10" }), output: { text: JSON.stringify(value) } }));
  const report = collectReviewMeasurements(query, fixture(record, { checks, jobs: [{ name: "review", id: 20 }, { name: "review", id: 21 }] }).read);
  assert.equal(report.rows.length, 2); assert.notEqual(report.rows[0].measurement.invocationId, report.rows[1].measurement.invocationId);
  assert.deepEqual(report.rows.map((row) => row.binding), [{ status: "unknown", reason: "job_binding_conflict" }, { status: "unknown", reason: "job_binding_conflict" }]);
});

test("pagination and API failures are bounded and diagnosed", () => {
  const calls: string[] = [];
  const report = collectReviewMeasurements({ ...query, maxPages: 2 }, (endpoint) => { calls.push(endpoint); return { total_count: 250, check_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) }; });
  assert.equal(calls.length, 2); assert.deepEqual(report.rows, []); assert.deepEqual(report.diagnostics, [{ checkRunId: null, reason: "pagination_limit" }]);
  const failed = collectReviewMeasurements(query, () => { throw new Error("private provider detail"); });
  assert.deepEqual(failed.diagnostics, [{ checkRunId: null, reason: "api_read_failed" }]); assert.equal(JSON.stringify(failed).includes("private provider"), false);
});

test("timestamp failures and CLI inputs are strict without echoing external values", () => {
  assert.deepEqual(utcDuration("2026-10-16T00:00:00Z", "2026-10-16T00:00:20Z"), { status: "observed", valueMs: 20000, clock: "github_utc" });
  assert.deepEqual(utcDuration("2026-10-16T00:00:20Z", "2026-10-16T00:00:00Z"), { status: "unknown", reason: "clock_order_conflict" });
  assert.deepEqual(utcDuration("2026-02-31T00:00:00Z", "2026-10-16T00:00:00Z"), { status: "unknown", reason: "invalid_timestamp" });
  assert.deepEqual(utcDuration("2026-10-16T00:00:00+00:00", null), { status: "unknown", reason: "missing_timestamp" });
  assert.deepEqual(parseMeasurementArgs(["org/repo", "7", "--head", query.targetHeadSha, "--workflow-id", "44", "--workflow-path", query.workflowPath]), { ...query, maxPages: 3 });
  assert.deepEqual(parseMeasurementArgs(["--help"]), { help: true });
  assert.throws(() => parseMeasurementArgs(["org/repo", "7", "--head", query.targetHeadSha, "--workflow-id", "44", "--workflow-path", query.workflowPath, "--max-pages", "11"]), /invalid measurement query/);
});


test("collector CLI uses bounded read-only gh requests and emits the public row", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-measurement-cli-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const record = receipt(); const source = fixture(record);
  const endpoints = [
    `repos/org/repo/commits/${query.targetHeadSha}/check-runs?check_name=Needlefish&filter=all&per_page=100&page=1`,
    "repos/org/repo/actions/runs/10/attempts/2",
    "repos/org/repo/actions/runs/10/attempts/2/jobs?per_page=100&page=1",
  ];
  const responses = Object.fromEntries(endpoints.map((endpoint) => [endpoint, source.read(endpoint)]));
  const fakeGh = path.join(tmp, "gh"); const calls = path.join(tmp, "calls.jsonl");
  writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n');
const responses = ${JSON.stringify(responses)};
if (args.length !== 2 || args[0] !== 'api' || !(args[1] in responses)) process.exit(7);
process.stdout.write(JSON.stringify(responses[args[1]]));
`);
  chmodSync(fakeGh, 0o755);
  const run = spawnSync(process.execPath, ["--import", "tsx", "eval/tools/review-measurements.ts", "org/repo", "7", "--head", query.targetHeadSha, "--workflow-id", "44", "--workflow-path", query.workflowPath], { encoding: "utf8", env: { PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}`, HOME: tmp } });
  assert.equal(run.status, 0, run.stderr); assert.equal(run.stderr, "");
  const report: unknown = JSON.parse(run.stdout); assert.ok(typeof report === "object" && report !== null);
  const rows: unknown = Reflect.get(report, "rows"); assert.ok(Array.isArray(rows)); assert.equal(rows.length, 1);
  const row: unknown = rows[0]; assert.ok(typeof row === "object" && row !== null);
  assert.equal(Reflect.get(row, "checkRunId"), 30); assert.deepEqual(Reflect.get(row, "binding"), { status: "producer_attested" });
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").map((line) => JSON.parse(line)), endpoints.map((endpoint) => ["api", endpoint]));
});

test("completed check outcome conflicts remain unknown without rewriting the record", () => {
  const report = collectReviewMeasurements(query, fixture(receipt(), { check: { conclusion: "failure" } }).read);
  assert.equal(report.rows[0].measurement.verdict, "pass");
  assert.deepEqual(report.rows[0].binding, { status: "unknown", reason: "check_outcome_conflict" });
  assert.deepEqual(report.rows[0].durations.jobQueueMs, { status: "unknown", reason: "unbound_job" });
  assert.deepEqual(report.diagnostics, [{ checkRunId: 30, reason: "check_outcome_conflict" }]);
});

test("collector never exceeds the global API read budget", () => {
  const records = Array.from({ length: 60 }, (_, index) => receipt({ workflow: { status: "recorded", runId: String(index + 10), runAttempt: 2, jobKey: "review" } }));
  const checks = records.map((record, index) => ({ id: index + 100, name: "Needlefish", head_sha: query.targetHeadSha, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" }, external_id: JSON.stringify({ v: 2, prNumber: 7, roundId: record.invocationId, runId: record.workflow.status === "recorded" ? record.workflow.runId : "" }), output: { text: JSON.stringify(record) } }));
  let calls = 0;
  const report = collectReviewMeasurements(query, (endpoint) => {
    calls++;
    if (endpoint.includes("/commits/")) return { total_count: checks.length, check_runs: checks };
    const match = /\/runs\/(\d+)\/attempts\/2/.exec(endpoint); assert.ok(match);
    const runId = Number(match[1]);
    if (endpoint.includes("/jobs?")) return { total_count: 1, jobs: [{ id: runId + 1000, run_id: runId, run_attempt: 2, name: "review", status: "completed", check_run_url: `https://api.github.com/repos/org/repo/check-runs/${runId + 2000}` }] };
    return { id: runId, run_attempt: 2, workflow_id: 44, path: query.workflowPath, repository: { full_name: query.repository }, head_sha: "b".repeat(40) };
  });
  assert.equal(calls, 100); assert.equal(report.rows.length, 60); assert.equal(report.partial, true);
  assert.equal(report.diagnostics.some((item) => item.reason === "request_limit"), true);
});
