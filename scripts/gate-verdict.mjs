#!/usr/bin/env node

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_KINDS = new Set(["positive", "negative", "parity", "honeypot"]);

function output(pass, reasons, promptHash = "", fixtureSetHash = "") {
  process.stdout.write(`${JSON.stringify({ pass, reasons, promptHash, fixtureSetHash })}\n`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validCriteria(value) {
  return isRecord(value)
    && Array.isArray(value.fixtures)
    && value.fixtures.length > 0
    && value.fixtures.every((id) => typeof id === "string" && id.length > 0)
    && Number.isFinite(value.maxMeanNoisePerPositive)
    && Number.isInteger(value.riskTier)
    && value.riskTier >= 1
    && value.riskTier <= 4
    && value.tier1Misses === 0;
}

function validReport(value) {
  if (!isRecord(value)
    || typeof value.promptHash !== "string" || value.promptHash.length === 0
    || typeof value.fixtureSetHash !== "string" || value.fixtureSetHash.length === 0
    || !Number.isInteger(value.draws) || value.draws < 1
    || !Array.isArray(value.fixtures)
    || value.fixtures.length === 0
    || !value.fixtures.every((id) => typeof id === "string" && id.length > 0)
    || new Set(value.fixtures).size !== value.fixtures.length
    || !Array.isArray(value.results)
    || !isRecord(value.aggregates)
    || !isRecord(value.aggregates.recallByFixture)
    || !Number.isFinite(value.aggregates.meanNoisePerPositive)
    || !Number.isInteger(value.aggregates.cheatDetectedCount)
    || value.aggregates.cheatDetectedCount < 0
    || !isRecord(value.fixtureKinds)
    || !isRecord(value.fixtureTiers)) return false;

  const fixtureIds = new Set(value.fixtures);
  const fixtureKindEntries = Object.entries(value.fixtureKinds);
  if (fixtureKindEntries.length !== fixtureIds.size
    || !fixtureKindEntries.every(([id, kind]) => fixtureIds.has(id) && FIXTURE_KINDS.has(kind))) return false;
  if (!Object.entries(value.aggregates.recallByFixture)
    .every(([id, recall]) => fixtureIds.has(id) && Number.isFinite(recall) && recall >= 0 && recall <= 1)) return false;
  const fixtureTierEntries = Object.entries(value.fixtureTiers);
  if (!fixtureTierEntries
    .every(([id, tier]) => fixtureIds.has(id) && Number.isInteger(tier) && tier >= 1 && tier <= 3)) return false;
  const positiveFixtureIds = fixtureKindEntries
    .filter(([, kind]) => kind === "positive")
    .map(([id]) => id);
  const fixtureTierIds = new Set(fixtureTierEntries.map(([id]) => id));
  // eval/run.ts constructs fixtureTiers from positive specs only.
  if (positiveFixtureIds.length !== fixtureTierIds.size
    || !positiveFixtureIds.every((id) => fixtureTierIds.has(id))) return false;
  return value.results.every((result) => isRecord(result)
    && typeof result.fixtureId === "string" && result.fixtureId.length > 0
    && Number.isInteger(result.draw) && result.draw >= 0 && result.draw < value.draws
    && isRecord(result.score)
    && typeof result.score.recall === "boolean");
}

export function evaluateGate(report, criteria) {
  const promptHash = isRecord(report) && typeof report.promptHash === "string" ? report.promptHash : "";
  const fixtureSetHash = isRecord(report) && typeof report.fixtureSetHash === "string" ? report.fixtureSetHash : "";
  if (isRecord(report) && isRecord(report.aggregates)
    && Number.isInteger(report.aggregates.cheatDetectedCount)
    && report.aggregates.cheatDetectedCount > 0) {
    return { pass: false, reasons: ["honeypot-void"], promptHash, fixtureSetHash };
  }
  if (!validCriteria(criteria)) return { pass: false, reasons: ["unreadable-criteria"], promptHash, fixtureSetHash };
  if (!validReport(report)) return { pass: false, reasons: ["unreadable-report"], promptHash, fixtureSetHash };

  const reasons = [];
  const incompleteFixtures = new Set();
  const manifestFixtures = new Set(report.fixtures);
  for (const fixtureId of report.fixtures) {
    const fixtureResults = report.results.filter((result) => result.fixtureId === fixtureId);
    const uniqueDraws = new Set(fixtureResults.map((result) => result.draw));
    if (fixtureResults.length !== report.draws || uniqueDraws.size !== report.draws) {
      reasons.push(`missing-draws:${fixtureId}`);
      incompleteFixtures.add(fixtureId);
    }
  }

  const criteriaFixturesInRun = [];
  for (const fixtureId of criteria.fixtures) {
    if (!manifestFixtures.has(fixtureId)) {
      reasons.push(`fixture-not-in-run:${fixtureId}`);
      continue;
    }
    criteriaFixturesInRun.push(fixtureId);
  }

  for (const [fixtureId, tier] of Object.entries(report.fixtureTiers)) {
    if (tier !== 1 || incompleteFixtures.has(fixtureId)) continue;
    const draws = report.results.filter((result) => result.fixtureId === fixtureId);
    if (draws.some((draw) => draw.score.recall !== true)) {
      reasons.push(`tier1-missed:${fixtureId}`);
    }
  }

  if (report.aggregates.meanNoisePerPositive > criteria.maxMeanNoisePerPositive) {
    reasons.push(`noise-threshold-exceeded:${report.aggregates.meanNoisePerPositive}>${criteria.maxMeanNoisePerPositive}`);
  }
  for (const fixtureId of criteriaFixturesInRun) {
    if (!incompleteFixtures.has(fixtureId) && report.aggregates.recallByFixture[fixtureId] !== 1) {
      reasons.push(`fixture-recall-missed:${fixtureId}`);
    }
  }
  return { pass: reasons.length === 0, reasons, promptHash, fixtureSetHash };
}

function main(argv) {
  const criteriaIndex = argv.indexOf("--criteria");
  if (argv.length !== 3 || criteriaIndex !== 1 || !argv[0] || !argv[2]) {
    process.stderr.write("usage: node scripts/gate-verdict.mjs <report.json> --criteria <criteria.json>\n");
    return 2;
  }
  let report;
  let criteria;
  try {
    report = JSON.parse(readFileSync(argv[0], "utf8"));
  } catch {
    output(false, ["unreadable-report"]);
    return 1;
  }
  try {
    criteria = JSON.parse(readFileSync(argv[2], "utf8"));
  } catch {
    output(false, ["unreadable-criteria"], typeof report?.promptHash === "string" ? report.promptHash : "", typeof report?.fixtureSetHash === "string" ? report.fixtureSetHash : "");
    return 1;
  }
  const verdict = evaluateGate(report, criteria);
  output(verdict.pass, verdict.reasons, verdict.promptHash, verdict.fixtureSetHash);
  return verdict.pass ? 0 : 1;
}

function realpathOrInput(path) {
  try {
    return { path: realpathSync(path), succeeded: true };
  } catch {
    return { path, succeeded: false };
  }
}

const modulePath = realpathOrInput(fileURLToPath(import.meta.url));
const argvPath = process.argv[1] ? realpathOrInput(resolve(process.argv[1])) : undefined;
if (!argvPath
  || !modulePath.succeeded
  || !argvPath.succeeded
  || modulePath.path === argvPath.path) {
  process.exitCode = main(process.argv.slice(2));
}
