import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newMeasurement, type MeasurementV1 } from "../../src/adapters/github-measurement.js";
import { parsePrPage, rowsFromPr, renderReport, type AdoptionRow } from "./adoption.js";
import { enrichAdoptionRows, measurementOptions, parseFindingMeasurement, type MeasurementContract } from "./adoption-measurements.js";
import { writeWeeklyReport } from "./adoption-weekly.js";
import type { GithubRead } from "./review-measurements.js";

const contract: MeasurementContract = { workflowPath: ".github/workflows/review.yml", jobKey: "review", jobName: "Review source" };
const repo = "frankekn/needlefish";
const sha = "a".repeat(40), oldSha = "b".repeat(40);
function receipt(head = sha, reviewId = 101): MeasurementV1 {
  return { ...newMeasurement({ repository: repo, prNumber: 7, targetHeadSha: head, workflow: { status: "recorded", runId: "10", runAttempt: 2, jobKey: "review" } }),
    summaryReviewId: 100, inlineReviewIds: [reviewId], outcome: "verdict", verdict: "pass", delivery: "delivered",
    pipeline: { status: "observed", clock: "producer_monotonic", elapsedMs: 2500 },
    runtime: { status: "recorded", runner: "codex", model: { status: "operator_attested", value: head === sha ? "new-model" : "old-model" }, effort: { status: "known", value: "high" }, coreVersion: { status: "unknown" }, qualification: { matchStatus: "unqualified" } } };
}
function finding(head = sha, reviewId = 101, commentId = 1): AdoptionRow {
  return { repo, pr: 7, severity: "P2", category: "validation", fate: "addressed", resolved: false, path: "src/a.ts", created: "2026-10-10T12:00:00Z", author: "github-actions",
    measurement: { status: "unknown", reason: "not_collected", identity: { commentId, originalHeadSha: head, reviewId } } };
}
function api(records: readonly MeasurementV1[], extraChecks: readonly Record<string, unknown>[] = []): GithubRead {
  return (endpoint) => {
    if (endpoint.endsWith("/actions/workflows/review.yml")) return { id: 44, path: contract.workflowPath };
    if (endpoint.includes("/commits/")) return { total_count: records.length + extraChecks.length, check_runs: [...records.filter((r) => endpoint.includes(r.targetHeadSha)).map((r, index) => ({ id: 30 + index, name: "Needlefish", head_sha: r.targetHeadSha, status: "completed", conclusion: "success", started_at: "2026-10-10T12:00:00Z", completed_at: "2026-10-10T12:00:20Z", app: { id: 15368, slug: "github-actions" }, external_id: JSON.stringify({ v: 2, prNumber: 7, roundId: r.invocationId, runId: "10" }), output: { text: JSON.stringify(r) } })), ...extraChecks] };
    if (endpoint.endsWith("/attempts/2")) return { id: 10, run_attempt: 2, workflow_id: 44, path: contract.workflowPath, repository: { full_name: repo }, head_sha: "c".repeat(40), created_at: "2026-10-10T12:00:00Z" };
    if (endpoint.includes("/jobs?")) return { total_count: 1, jobs: [{ id: 20, run_id: 10, run_attempt: 2, name: contract.jobName, status: "completed", created_at: "2026-10-10T12:00:01Z", started_at: "2026-10-10T12:00:11Z", check_run_url: `https://api.github.com/repos/${repo}/check-runs/21` }] };
    throw new Error("unexpected endpoint");
  };
}

test("historical head and original inline review retain lane despite an edited shared summary", () => {
  const old = receipt(oldSha, 99), current = receipt();
  const joined = enrichAdoptionRows([finding(oldSha, 99), finding(), finding(oldSha, 100), { ...finding(), measurement: undefined }], contract, api([old, current]));
  assert.deepEqual(joined.map((r) => r.measurement?.status), ["producer_attested", "producer_attested", "unknown", "unknown"]);
  const first = joined[0].measurement;
  assert.ok(first?.status === "producer_attested");
  assert.deepEqual(first.receipt.runtime, old.runtime);
  assert.equal(first.identity.originalHeadSha, oldSha);
  assert.deepEqual(first.durations.jobQueueMs, { status: "observed", valueMs: 10000, clock: "github_utc" });
  assert.deepEqual(first.durations.pushToTerminalMs, { status: "unknown", reason: "missing_trusted_push_time" });
  assert.deepEqual(joined[2].measurement, { status: "unknown", identity: { commentId: 1, originalHeadSha: oldSha, reviewId: 100 }, reason: "missing_inline_review_binding" });
  assert.equal(joined.length, 4);
  const report = renderReport(joined, null);
  assert.match(report, /Finding coverage: 2\/4 producer-attested; 2 unknown/);
  assert.match(report, /old-model/); assert.match(report, /new-model/); assert.match(report, /median 2500; n=1; unknown=0/);
});

test("same-head rounds claiming the same inline review are ambiguous, not latest wins", () => {
  const joined = enrichAdoptionRows([finding()], contract, api([receipt(), receipt()]));
  assert.equal(joined[0].measurement?.status, "unknown");
  assert.equal(joined[0].measurement?.status === "unknown" && joined[0].measurement.reason, "ambiguous_review_binding");
});

test("missing permissions, conflicting receipts and truncated API pages preserve the finding", () => {
  const a = receipt();
  const checks = [{ id: 31, name: "Needlefish", head_sha: sha, status: "completed", conclusion: "success", app: { id: 15368, slug: "github-actions" }, external_id: "", output: { text: JSON.stringify({ ...a, delivery: "partial" }) } }];
  for (const read of [(() => { throw new Error("secret endpoint detail"); }), api([a], checks), ((endpoint: string) => endpoint.endsWith("/actions/workflows/review.yml") ? { id: 44, path: contract.workflowPath } : { total_count: 999, check_runs: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })) })]) {
    let calls = 0;
    const rows = enrichAdoptionRows([finding()], contract, (endpoint) => { calls++; return read(endpoint); });
    assert.equal(rows.length, 1); assert.equal(rows[0].fate, "addressed"); assert.equal(rows[0].measurement?.status, "unknown");
    assert.ok(calls <= 4); assert.equal(JSON.stringify(rows).includes("secret endpoint"), false);
  }
});

test("global measurement read ceiling and cache bound repeated findings", () => {
  let calls = 0;
  const rows = Array.from({ length: 200 }, (_, index) => finding(index.toString(16).padStart(40, "0"), 101, index + 1));
  const joined = enrichAdoptionRows(rows, contract, (endpoint) => { calls++; return api([])(endpoint); });
  assert.equal(calls, 100); assert.equal(joined.length, 200);
  assert.equal(joined.filter((r) => r.measurement?.status === "unknown").length, 200);
  calls = 0;
  const repeated = enrichAdoptionRows([finding(), finding(sha, 101, 2)], contract, (endpoint) => { calls++; return api([receipt()])(endpoint); });
  assert.equal(calls, 4); assert.equal(repeated.length, 2);
  assert.match(renderReport(repeated, null), /median 2500; n=1; unknown=0/);
});

test("strict options and weekly parser preserve provenance and reject invented push clock", () => {
  assert.deepEqual(measurementOptions(["--measurement-workflow", contract.workflowPath, "--measurement-job-key", "review", "--measurement-job-name", "Review source"]), contract);
  assert.throws(() => measurementOptions(["--measurement-workflow", contract.workflowPath]), /explicit/);
  assert.throws(() => measurementOptions(["--measurement-job-key", "review", "--measurement-job-key", "review"]), /invalid/);
  const joined = enrichAdoptionRows([finding()], contract, api([receipt()]))[0].measurement;
  assert.ok(joined?.status === "producer_attested");
  assert.deepEqual(parseFindingMeasurement(JSON.parse(JSON.stringify(joined))), joined);
  assert.throws(() => parseFindingMeasurement({ ...joined, durations: { ...joined.durations, pushToTerminalMs: { status: "observed", valueMs: 0, clock: "github_utc" } } }), /unsupported event clock/);
  assert.throws(() => parseFindingMeasurement({ ...joined, identity: { ...joined.identity, reviewId: 100 } }), /historical/);
});

test("actual collector CLI and weekly replay use GET-only exact historical joins", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-adoption-measurements-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const old = receipt(oldSha, 99), current = receipt();
  const comments = [[oldSha, 99], [sha, 101], [oldSha, 100]].map(([head, reviewId], index) => ({ isOutdated: index === 0, isResolved: false, path: "src/a.ts", comments: { nodes: [{ databaseId: index + 1, originalCommit: { oid: head }, pullRequestReview: { databaseId: reviewId }, author: { login: "github-actions" }, body: "**P2 (validation): Literal finding**", createdAt: "2026-10-10T12:00:00Z" }] } }));
  const graph = { data: { repository: { pullRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ number: 7, state: "MERGED", merged: true, updatedAt: "2026-10-10T12:00:00Z", reviews: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [{ id: "edited-summary", body: "latest summary is irrelevant" }] }, reviewThreads: { pageInfo: { hasNextPage: false }, nodes: comments } }] } } } };
  const endpoints = [`repos/${repo}/actions/workflows/review.yml`, ...[oldSha, sha].map((head) => `repos/${repo}/commits/${head}/check-runs?check_name=Needlefish&filter=all&per_page=100&page=1`), `repos/${repo}/actions/runs/10/attempts/2`, `repos/${repo}/actions/runs/10/attempts/2/jobs?per_page=100&page=1`];
  const responses = Object.fromEntries(endpoints.map((endpoint) => [endpoint, api([old, current])(endpoint)]));
  const log = path.join(tmp, "calls.jsonl");
  writeFileSync(path.join(tmp, "gh"), `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');const responses=${JSON.stringify(responses)};if(args[0]!=='api')process.exit(8);if(args[1]==='graphql'){process.stdout.write(${JSON.stringify(JSON.stringify(graph))});}else{if(args.length!==2||!(args[1] in responses))process.exit(9);process.stdout.write(JSON.stringify(responses[args[1]]));}\n`);
  chmodSync(path.join(tmp, "gh"), 0o755);
  const env = { ...process.env, PATH: `${tmp}${path.delimiter}${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: repo };
  const args = [repo, "--json", "--measurement-workflow", contract.workflowPath, "--measurement-job-key", "review", "--measurement-job-name", contract.jobName];
  const cli = spawnSync(process.execPath, ["--import", "tsx", "eval/tools/adoption.ts", ...args], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(cli.status, 0, cli.stderr);
  const rows: unknown = JSON.parse(cli.stdout); assert.ok(Array.isArray(rows)); assert.equal(rows.length, 3);
  const page = parsePrPage(graph);
  const expected = enrichAdoptionRows(rowsFromPr(repo, page.prs[0], null, true), contract, api([old, current]));
  assert.deepEqual(rows, expected);
  const outputDir = path.join(tmp, "weekly");
  assert.equal(writeWeeklyReport({ outputDir, now: new Date("2026-10-16T12:00:00Z"), env, measurements: contract }), 0);
  assert.deepEqual(JSON.parse(readFileSync(path.join(outputDir, "rows.json"), "utf8")), expected);
  const metadata: unknown = JSON.parse(readFileSync(path.join(outputDir, "metadata.json"), "utf8"));
  assert.ok(typeof metadata === "object" && metadata !== null && "status" in metadata); assert.equal(metadata.status, "partial");
  assert.match(readFileSync(path.join(outputDir, "report.md"), "utf8"), /Finding coverage: 2\/3 producer-attested; 1 unknown/);
  const calls: string[][] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(calls.length, 16);
  assert.equal(calls.some((call) => call.includes("--method") || call.includes("-X") || call.includes("--input")), false);
  assert.ok(calls.filter((call) => call[1] !== "graphql").every((call) => call.length === 2));
});


test("weekly parser keeps incomplete receipts unknown without losing historical identity", () => {
  const joined = enrichAdoptionRows([finding()], contract, api([receipt()]))[0].measurement;
  assert.ok(joined?.status === "producer_attested");
  for (const delivery of ["partial", "verdict_check_published", "posting_failed", "not_applicable"]) {
    assert.deepEqual(parseFindingMeasurement({ ...joined, receipt: { ...joined.receipt, delivery } }), {
      status: "unknown", identity: joined.identity, reason: "incomplete_delivery",
    });
  }
  assert.deepEqual(parseFindingMeasurement(joined), joined);
});

test("weekly CLI preserves incomplete stdout rows in unknown coverage and keeps complete receipts", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-weekly-delivery-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const row = enrichAdoptionRows([finding()], contract, api([receipt()]))[0];
  assert.ok(row.measurement?.status === "producer_attested");
  const preload = path.join(tmp, "stdout-boundary.mjs");
  writeFileSync(preload, `import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { readFileSync } from 'node:fs';
const original = childProcess.spawnSync;
childProcess.spawnSync = function(command, args, options) {
  if (Array.isArray(args) && args.some(arg => typeof arg === 'string' && arg.endsWith('/eval/tools/adoption.ts'))) {
    return { status: 0, signal: null, stdout: readFileSync(process.env.NF_BOUNDARY_ROWS, 'utf8'), stderr: '', pid: 0, output: [] };
  }
  return original(command, args, options);
};
syncBuiltinESMExports();
`);
  for (const delivery of ["partial", "delivered"] as const) {
    const input = [{ ...row, created: new Date(Date.now() - 86_400_000).toISOString(), measurement: { ...row.measurement, receipt: { ...row.measurement.receipt, delivery } } }];
    const inputFile = path.join(tmp, `${delivery}.json`), outputDir = path.join(tmp, delivery);
    writeFileSync(inputFile, JSON.stringify(input));
    const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload, "eval/tools/adoption-weekly.ts", outputDir,
      "--measurement-workflow", contract.workflowPath, "--measurement-job-key", contract.jobKey, "--measurement-job-name", contract.jobName], {
      env: { ...process.env, GITHUB_REPOSITORY: repo, NF_BOUNDARY_ROWS: inputFile }, encoding: "utf8", timeout: 30_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const incomplete = delivery === "partial";
    const expected = [{ ...input[0], measurement: incomplete ? { status: "unknown", identity: row.measurement.identity, reason: "incomplete_delivery" } : row.measurement }];
    assert.deepEqual(JSON.parse(readFileSync(path.join(outputDir, "rows.json"), "utf8")), expected);
    const metadata: unknown = JSON.parse(readFileSync(path.join(outputDir, "metadata.json"), "utf8"));
    assert.ok(typeof metadata === "object" && metadata !== null && "status" in metadata && "findingThreads" in metadata && "measurements" in metadata);
    assert.equal(metadata.status, incomplete ? "partial" : "collected");
    assert.equal(metadata.findingThreads, 1);
    assert.deepEqual(metadata.measurements, { contract, findingDenominator: 1, unknown: incomplete ? 1 : 0, scope: "producer_attested_only" });
    assert.ok(readFileSync(path.join(outputDir, "report.md"), "utf8").includes(incomplete
      ? "Finding coverage: 0/1 producer-attested; 1 unknown" : "Finding coverage: 1/1 producer-attested; 0 unknown"));
  }
});
