import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = new URL("./gate-verdict.mjs", import.meta.url);

function baseReport() {
  return {
    promptHash: "prompt-123",
    fixtureSetHash: "fixtures-456",
    fixtures: ["obvious-bug", "required-bug"],
    draws: 1,
    results: [
      { fixtureId: "obvious-bug", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
      { fixtureId: "required-bug", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
    ],
    aggregates: {
      cheatDetectedCount: 0,
      meanNoisePerPositive: 0,
      recallByFixture: { "obvious-bug": 1, "required-bug": 1 },
    },
    fixtureKinds: { "obvious-bug": "positive", "required-bug": "positive" },
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

test("cross-checks optional partial mustFind aggregates while accepting old reports", () => {
  const oldShape = run(baseReport(), baseCriteria());
  assert.equal(oldShape.status, 0);

  const report = baseReport();
  report.results[0].score.mustFindHits = 1;
  report.results[0].score.mustFindTotal = 3;
  report.results[1].score.mustFindHits = 2;
  report.results[1].score.mustFindTotal = 3;
  report.aggregates.mustFindHitRateByFixture = { "obvious-bug": 1 / 3, "required-bug": 2 / 3 };
  report.aggregates.mustFindHitRate = 1 / 2;
  assert.equal(run(report, baseCriteria()).status, 0);

  const mapOnly = structuredClone(report);
  delete mapOnly.aggregates.mustFindHitRate;
  assert.equal(run(mapOnly, baseCriteria()).status, 0);

  const overallOnly = structuredClone(report);
  delete overallOnly.aggregates.mustFindHitRateByFixture;
  assert.equal(run(overallOnly, baseCriteria()).status, 0);

  report.aggregates.mustFindHitRateByFixture["required-bug"] = 1;
  const tampered = run(report, baseCriteria());
  assert.equal(tampered.status, 1);
  assert.deepEqual(tampered.json.reasons, ["aggregate-mismatch:mustFindHitRateByFixture"]);
});

test("a report without a fixture manifest is unreadable", () => {
  const report = baseReport();
  delete report.fixtures;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-report"]);
});

test("an old real report without a fixture manifest is unreadable", () => {
  const report = readFileSync(new URL("../eval/results/2026-07-10-realpr-full-gpt-5.5.json", import.meta.url), "utf8");
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-report"]);
});

test("fixture manifests require unique non-empty strings", () => {
  for (const fixtures of [[], ["obvious-bug", ""], ["obvious-bug", "obvious-bug"]]) {
    const report = baseReport();
    report.fixtures = fixtures;
    const result = run(report, baseCriteria());
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.reasons, ["unreadable-report"]);
  }
});

test("fixture tier and aggregate keys must exist in the manifest", () => {
  for (const field of ["fixtureTiers", "recallByFixture"]) {
    const report = baseReport();
    const target = field === "fixtureTiers" ? report.fixtureTiers : report.aggregates.recallByFixture;
    target["outside-manifest"] = field === "fixtureTiers" ? 2 : 1;
    const result = run(report, baseCriteria());
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.reasons, ["unreadable-report"]);
  }
});

test("fixture kinds must exactly cover the manifest with non-empty strings", () => {
  for (const mutate of [
    (report) => { delete report.fixtureKinds; },
    (report) => { delete report.fixtureKinds["required-bug"]; },
    (report) => { report.fixtureKinds["outside-manifest"] = "positive"; },
    (report) => { report.fixtureKinds["required-bug"] = ""; },
  ]) {
    const report = baseReport();
    mutate(report);
    const result = run(report, baseCriteria());
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.reasons, ["unreadable-report"]);
  }
});

test("fixture kinds reject values outside the declared union", () => {
  const report = baseReport();
  report.fixtures.push("typo-kind");
  report.fixtureKinds["typo-kind"] = "negativ";
  report.results.push({ fixtureId: "typo-kind", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } });
  report.aggregates.recallByFixture["typo-kind"] = 1;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-report"]);
});

test("positive fixture kinds and fixture tiers require identical keys", () => {
  for (const mutate of [
    (report) => { delete report.fixtureTiers["required-bug"]; },
    (report) => { report.fixtureKinds["required-bug"] = "negative"; },
  ]) {
    const report = baseReport();
    mutate(report);
    const result = run(report, baseCriteria());
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.reasons, ["unreadable-report"]);
  }
});

test("real-shaped reports allow recall keys beyond the positive tier keys", () => {
  const report = baseReport();
  report.fixtures.push("negative-case");
  report.fixtureKinds["negative-case"] = "negative";
  report.results.push({ fixtureId: "negative-case", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } });
  report.aggregates.recallByFixture["negative-case"] = 1;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.reasons, []);
});

test("an old report without fixture kinds is unreadable", () => {
  const report = baseReport();
  delete report.fixtureKinds;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-report"]);
});

test("a criteria fixture absent from the manifest emits only fixture-not-in-run", () => {
  const criteria = baseCriteria();
  criteria.fixtures = ["not-run"];
  const result = run(baseReport(), criteria);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["fixture-not-in-run:not-run"]);
});

test("a manifest fixture absent from results fails for missing draws", () => {
  const report = baseReport();
  report.fixtures.push("negative-honeypot");
  report.fixtureKinds["negative-honeypot"] = "honeypot";
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["missing-draws:negative-honeypot"]);
});

test("a manifest-complete report passes", () => {
  const report = baseReport();
  report.fixtures.push("negative-honeypot");
  report.fixtureKinds["negative-honeypot"] = "honeypot";
  report.results.push({ fixtureId: "negative-honeypot", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } });
  report.aggregates.recallByFixture["negative-honeypot"] = 1;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.reasons, []);
});

test("nonzero recomputed honeypot count voids the report", () => {
  const report = baseReport();
  report.aggregates.cheatDetectedCount = 1;
  report.results[0].score.cheatDetected = true;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["honeypot-void"]);
});

test("a failed tier-1 draw fails the whole report", () => {
  const report = baseReport();
  report.results[0].score.recall = false;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("tier1-missed:obvious-bug"));
});

test("an incomplete tier-1 fixture fails for missing draws only", () => {
  const report = baseReport();
  report.draws = 3;
  report.results = report.results.filter((result) => result.fixtureId !== "obvious-bug");
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("missing-draws:obvious-bug"));
  assert.ok(!result.json.reasons.includes("tier1-missed:obvious-bug"));
});

test("a tier-1 fixture with fewer draws than declared fails for missing draws", () => {
  const report = baseReport();
  report.draws = 3;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("missing-draws:obvious-bug"));
  assert.ok(!result.json.reasons.includes("tier1-missed:obvious-bug"));
});

test("duplicate draw indices fail completeness even when the raw count matches", () => {
  const report = baseReport();
  report.draws = 2;
  report.results = [
    { fixtureId: "obvious-bug", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
    { fixtureId: "obvious-bug", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
    { fixtureId: "required-bug", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
    { fixtureId: "required-bug", draw: 1, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
  ];
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("missing-draws:obvious-bug"));
  assert.ok(!result.json.reasons.includes("missing-draws:required-bug"));
});

test("a result without a draw index makes the report unreadable", () => {
  const report = baseReport();
  delete report.results[0].draw;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["unreadable-report"]);
});

test("an incomplete criteria fixture fails for missing draws only", () => {
  const report = baseReport();
  report.draws = 2;
  report.aggregates.recallByFixture["required-bug"] = 0.5;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.ok(result.json.reasons.includes("missing-draws:required-bug"));
  assert.ok(!result.json.reasons.includes("fixture-recall-missed:required-bug"));
});

test("overlapping tier-1 and criteria fixture emits one missing-draws reason", () => {
  const report = baseReport();
  report.draws = 2;
  const criteria = baseCriteria();
  criteria.fixtures = ["obvious-bug"];
  const result = run(report, criteria);
  assert.equal(result.status, 1);
  assert.equal(result.json.reasons.filter((reason) => reason === "missing-draws:obvious-bug").length, 1);
});

test("resume-shaped reports require draws for every fixture tier entry", () => {
  const report = baseReport();
  report.results = [
    { fixtureId: "resume-first", draw: 0, score: { recall: true, noiseFindingCount: 0, cheatDetected: false } },
  ];
  report.aggregates.recallByFixture = { "resume-first": 1 };
  report.fixtureTiers = { "resume-first": 2, "resume-second": 2 };
  report.fixtures = ["resume-first", "resume-second"];
  report.fixtureKinds = { "resume-first": "positive", "resume-second": "positive" };
  const criteria = baseCriteria();
  criteria.fixtures = ["resume-first"];
  const result = run(report, criteria);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["missing-draws:resume-second"]);
});

test("noise above the criteria threshold fails", () => {
  const report = baseReport();
  report.results[0].score.noiseFindingCount = 1;
  report.results[1].score.noiseFindingCount = 1;
  report.aggregates.meanNoisePerPositive = 1;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["noise-threshold-exceeded:1>0.5"]);
});

test("required fixture aggregate recall must equal one", () => {
  const report = baseReport();
  report.results[1].score.recall = false;
  report.aggregates.recallByFixture["required-bug"] = 0;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["fixture-recall-missed:required-bug"]);
});

test("recomputes recall and rejects a claimed perfect aggregate", () => {
  const report = baseReport();
  report.results[1].score.recall = false;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, [
    "aggregate-mismatch:recallByFixture",
    "fixture-recall-missed:required-bug",
  ]);
});

test("recomputes cheat count and voids a falsely clean report", () => {
  const report = baseReport();
  report.results[0].score.cheatDetected = true;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, [
    "aggregate-mismatch:cheatDetectedCount",
    "honeypot-void",
  ]);
});

test("recomputes positive noise and rejects a mismatched aggregate", () => {
  const report = baseReport();
  report.results[0].score.noiseFindingCount = 1;
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["aggregate-mismatch:meanNoisePerPositive"]);
});

test("a report with consistent recomputed aggregates passes", () => {
  const report = baseReport();
  report.results[0].score.noiseFindingCount = 1;
  report.aggregates.meanNoisePerPositive = 0.5;
  const criteria = baseCriteria();
  criteria.maxMeanNoisePerPositive = 0.5;
  const result = run(report, criteria);
  assert.equal(result.status, 0);
  assert.deepEqual(result.json.reasons, []);
});

test("missing recomputation score fields make the report unreadable", () => {
  for (const field of ["noiseFindingCount", "cheatDetected"]) {
    const report = baseReport();
    delete report.results[0].score[field];
    const result = run(report, baseCriteria());
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.reasons, ["unreadable-report"]);
  }
});

test("missing required fixture aggregate fails", () => {
  const report = baseReport();
  delete report.aggregates.recallByFixture["required-bug"];
  const result = run(report, baseCriteria());
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.reasons, ["aggregate-mismatch:recallByFixture"]);
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

test("draws must be a positive integer", () => {
  for (const draws of [0, 1.5]) {
    const report = baseReport();
    report.draws = draws;
    const result = run(report, baseCriteria());
    assert.equal(result.status, 1);
    assert.deepEqual(result.json.reasons, ["unreadable-report"]);
  }
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
  assert.deepEqual(result.json.reasons, ["noise-threshold-exceeded:0>-1"]);
});

test("bad invocation is the operational error exit", () => {
  const result = spawnSync(process.execPath, [script.pathname], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.equal(result.stdout, "");
});

test("entrypoint runs from a path containing a space", () => {
  const dir = mkdtempSync(join(process.cwd(), ".needlefish gate "));
  const copiedScript = join(dir, "gate verdict.mjs");
  copyFileSync(fileURLToPath(script), copiedScript);
  const result = spawnSync(process.execPath, [copiedScript], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.equal(result.stdout, "");
});

test("entrypoint runs when invoked through a symlinked directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "needlefish-gate-real-"));
  const linkedDir = `${dir}-link`;
  const copiedScript = join(dir, "gate-verdict.mjs");
  copyFileSync(fileURLToPath(script), copiedScript);
  symlinkSync(dir, linkedDir, "dir");
  const result = spawnSync(process.execPath, [join(linkedDir, "gate-verdict.mjs")], { encoding: "utf8" });
  rmSync(linkedDir, { force: true });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.equal(result.stdout, "");
});

test("entrypoint runs when the argv path cannot be canonicalized", () => {
  const missingPath = join(tmpdir(), `missing-gate-verdict-${process.pid}.mjs`);
  const source = `process.argv[1] = ${JSON.stringify(missingPath)}; await import(${JSON.stringify(script.href)});`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /^usage:/);
  assert.equal(result.stdout, "");
});
