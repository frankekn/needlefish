import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./gate-verdict.mjs", import.meta.url);

function baseReport() {
  return {
    promptHash: "prompt-123",
    fixtureSetHash: "fixtures-456",
    results: [
      { fixtureId: "obvious-bug", score: { recall: true } },
      { fixtureId: "required-bug", score: { recall: true } },
    ],
    aggregates: {
      cheatDetectedCount: 0,
      meanNoisePerPositive: 0.25,
      recallByFixture: { "obvious-bug": 1, "required-bug": 1 },
    },
    fixtureTiers: { "obvious-bug": 1, "required-bug": 2 },
  };
}

function baseCriteria() {
  return { fixtures: ["required-bug"], riskTier: 2, maxMeanNoisePerPositive: 0.5, tier1Misses: 0 };
}

function run(report, criteria) {
  const dir = mkdtempSync(join(tmpdir(), "needlefish-gate-"));
  const reportPath = join(dir, "report.json");
  const criteriaPath = join(dir, "criteria.json");
  writeFileSync(reportPath, typeof report === "string" ? report : JSON.stringify(report));
  writeFileSync(criteriaPath, typeof criteria === "string" ? criteria : JSON.stringify(criteria));
  const result = spawnSync(process.execPath, [script.pathname, reportPath, "--criteria", criteriaPath], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: JSON.parse(result.stdout) };
}

test("passes and echoes report hashes", () => {
  const result = run(baseReport(), baseCriteria());
  assert.equal(result.status, 0);
  assert.deepEqual(result.json, { pass: true, reasons: [], promptHash: "prompt-123", fixtureSetHash: "fixtures-456" });
});

test("nonzero honeypot count voids the report", () => {
  const report = baseReport();
  report.aggregates.cheatDetectedCount = 1;
  delete report.aggregates.meanNoisePerPositive;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["honeypot-void"]);
});

test("a failed tier-1 draw fails the whole report", () => {
  const report = baseReport();
  report.results.push({ fixtureId: "obvious-bug", score: { recall: false } });
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("tier1-missed:obvious-bug"));
});

test("a tier-1 fixture with no draw fails closed", () => {
  const report = baseReport();
  report.results = report.results.filter((result) => result.fixtureId !== "obvious-bug");
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("tier1-missed:obvious-bug"));
});

test("noise above the criteria threshold fails", () => {
  const report = baseReport();
  report.aggregates.meanNoisePerPositive = 0.51;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["noise-threshold-exceeded:0.51>0.5"]);
});

test("required fixture aggregate recall must equal one", () => {
  const report = baseReport();
  report.aggregates.recallByFixture["required-bug"] = 0.5;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["fixture-recall-missed:required-bug"]);
});

test("missing required fixture aggregate fails", () => {
  const report = baseReport();
  delete report.aggregates.recallByFixture["required-bug"];
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["fixture-recall-missed:required-bug"]);
});

test("malformed report is an ordinary closed failure", () => {
  const result = run("{not-json", baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json, { pass: false, reasons: ["unreadable-report"], promptHash: "", fixtureSetHash: "" });
});

test("missing report metrics fail closed without crashing", () => {
  const report = baseReport();
  delete report.aggregates.cheatDetectedCount;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-report"]);
});

test("malformed criteria fails closed", () => {
  const criteria = baseCriteria();
  criteria.fixtures = [];
  const result = run(baseReport(), criteria);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-criteria"]);
});

test("duplicate fixture criteria remain readable", () => {
  const criteria = baseCriteria();
  criteria.fixtures = ["required-bug", "required-bug"];
  const result = run(baseReport(), criteria);
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.reasons, []);
});

test("negative finite noise threshold evaluates normally", () => {
  const criteria = baseCriteria();
  criteria.maxMeanNoisePerPositive = -1;
  const result = run(baseReport(), criteria);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["noise-threshold-exceeded:0.25>-1"]);
});

test("bad invocation is the operational error exit", () => {
  const result = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.equal(result.stdout, "");
});
