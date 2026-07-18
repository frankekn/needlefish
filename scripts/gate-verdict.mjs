#!/usr/bin/env node
/* global process */

import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_KINDS = new Set(["positive", "negative", "parity", "honeypot"]);
const SCORER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "eval", "shared");
const SCORER_FILES = ["score.ts", "robustness.ts", "types.ts"];

export function computeScorerHash() {
  const hash = createHash("sha256");
  for (const name of SCORER_FILES) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(SCORER_DIR, name), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

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
  if (value.aggregates.mustFindHitRateByFixture !== undefined
    && (!isRecord(value.aggregates.mustFindHitRateByFixture)
      || !Object.entries(value.aggregates.mustFindHitRateByFixture)
        .every(([id, rate]) => fixtureIds.has(id) && Number.isFinite(rate) && rate >= 0 && rate <= 1))) return false;
  if (value.aggregates.mustFindHitRate !== undefined
    && (!Number.isFinite(value.aggregates.mustFindHitRate)
      || value.aggregates.mustFindHitRate < 0 || value.aggregates.mustFindHitRate > 1)) return false;
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
    && typeof result.score.recall === "boolean"
    && Number.isInteger(result.score.mustFindHits)
    && Number.isInteger(result.score.mustFindTotal)
    && result.score.mustFindHits >= 0
    && result.score.mustFindTotal >= result.score.mustFindHits
    && Number.isInteger(result.score.noiseFindingCount)
    && result.score.noiseFindingCount >= 0
    && typeof result.score.cheatDetected === "boolean");
}

function recomputeAggregates(report) {
  const recalls = new Map();
  for (const result of report.results) {
    const fixtureRecalls = recalls.get(result.fixtureId) ?? [];
    fixtureRecalls.push(result.score.recall);
    recalls.set(result.fixtureId, fixtureRecalls);
  }
  const recallByFixture = Object.fromEntries([...recalls].map(([fixtureId, values]) => [
    fixtureId,
    values.filter(Boolean).length / values.length,
  ]));
  const positiveResults = report.results.filter((result) => report.fixtureKinds[result.fixtureId] === "positive");
  const meanNoisePerPositive = positiveResults.length === 0
    ? 0
    : positiveResults.reduce((total, result) => total + result.score.noiseFindingCount, 0) / positiveResults.length;
  const cheatDetectedCount = report.results.filter((result) => result.score.cheatDetected).length;
  const mustFindRatesByFixture = new Map();
  for (const result of report.results) {
    if (result.score.mustFindTotal === 0) continue;
    const rates = mustFindRatesByFixture.get(result.fixtureId) ?? [];
    rates.push(result.score.mustFindHits / result.score.mustFindTotal);
    mustFindRatesByFixture.set(result.fixtureId, rates);
  }
  const mustFindHitRateByFixture = Object.fromEntries([...mustFindRatesByFixture].map(([fixtureId, rates]) => [
    fixtureId,
    rates.reduce((total, rate) => total + rate, 0) / rates.length,
  ]));
  const mustFindRates = Object.values(mustFindHitRateByFixture);
  const mustFindHitRate = mustFindRates.length === 0
    ? 0
    : mustFindRates.reduce((total, rate) => total + rate, 0) / mustFindRates.length;
  return { recallByFixture, meanNoisePerPositive, cheatDetectedCount, mustFindHitRateByFixture, mustFindHitRate };
}

function evidenceEntryOk(entry) {
  if (!isRecord(entry) || typeof entry.pattern !== "string") return false;
  if (entry.findingIndex !== null && (!Number.isInteger(entry.findingIndex) || entry.findingIndex < 0)) return false;
  if (entry.category !== undefined && typeof entry.category !== "string") return false;
  if (entry.file !== undefined && typeof entry.file !== "string") return false;
  if (entry.lineRange !== undefined
    && !(Array.isArray(entry.lineRange) && entry.lineRange.length === 2
      && entry.lineRange.every(Number.isFinite))) return false;
  try { new RegExp(entry.pattern, "i"); } catch { return false; }
  return true;
}

function isDrawFinding(finding) {
  return isRecord(finding)
    && typeof finding.severity === "string"
    && typeof finding.category === "string"
    && typeof finding.file === "string"
    && Number.isFinite(finding.lineStart)
    && Number.isFinite(finding.lineEnd)
    && typeof finding.title === "string"
    && typeof finding.whyItBreaks === "string";
}

function evidenceMatches(entry, finding) {
  if (!isDrawFinding(finding)) return false;
  if (entry.category && finding.category !== entry.category) return false;
  if (entry.file && !finding.file.endsWith(entry.file)) return false;
  if (entry.lineRange
    && (finding.lineStart < entry.lineRange[0] || finding.lineStart > entry.lineRange[1])) return false;
  return new RegExp(entry.pattern, "i").test(`${finding.title} ${finding.whyItBreaks}`);
}

function evidenceReasons(report) {
  const reasons = [];
  for (const result of report.results) {
    if (!Array.isArray(result.findings)
      || !result.findings.every(isDrawFinding)
      || !Array.isArray(result.matchEvidence)
      || result.matchEvidence.length !== result.score.mustFindTotal
      || !result.matchEvidence.every(evidenceEntryOk)) {
      reasons.push(`missing-evidence:${result.fixtureId}`);
      continue;
    }
    const actualIndexes = result.matchEvidence.map((entry) => {
      const index = result.findings.findIndex((finding) => evidenceMatches(entry, finding));
      return index < 0 ? null : index;
    });
    if (actualIndexes.some((index, i) => index !== result.matchEvidence[i].findingIndex)) {
      reasons.push(`unexplainable-evidence:${result.fixtureId}`);
    }
    const recall = result.score.formatOk === false
      ? false
      : actualIndexes.every((index) => index !== null);
    if (recall && result.score.recall !== true) reasons.push(`miss-with-evidence:${result.fixtureId}`);
    if (!recall && result.score.recall === true) reasons.push(`recall-without-evidence:${result.fixtureId}`);
  }
  return reasons;
}

function equalRecallMaps(left, right) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

export function evaluateGate(report, criteria) {
  const promptHash = isRecord(report) && typeof report.promptHash === "string" ? report.promptHash : "";
  const fixtureSetHash = isRecord(report) && typeof report.fixtureSetHash === "string" ? report.fixtureSetHash : "";
  if (!validCriteria(criteria)) return { pass: false, reasons: ["unreadable-criteria"], promptHash, fixtureSetHash };
  if (!validReport(report)) return { pass: false, reasons: ["unreadable-report"], promptHash, fixtureSetHash };

  const reasons = [];
  const aggregates = recomputeAggregates(report);
  if (typeof report.scorerHash !== "string" || report.scorerHash.length === 0) {
    reasons.push("scorer-hash-missing");
  } else if (report.scorerHash !== computeScorerHash()) {
    reasons.push("scorer-hash-mismatch");
  }
  if (!equalRecallMaps(report.aggregates.recallByFixture, aggregates.recallByFixture)) {
    reasons.push("aggregate-mismatch:recallByFixture");
  }
  if (report.aggregates.meanNoisePerPositive !== aggregates.meanNoisePerPositive) {
    reasons.push("aggregate-mismatch:meanNoisePerPositive");
  }
  if (report.aggregates.cheatDetectedCount !== aggregates.cheatDetectedCount) {
    reasons.push("aggregate-mismatch:cheatDetectedCount");
  }
  if (report.aggregates.mustFindHitRateByFixture !== undefined
    && !equalRecallMaps(report.aggregates.mustFindHitRateByFixture, aggregates.mustFindHitRateByFixture)) {
    reasons.push("aggregate-mismatch:mustFindHitRateByFixture");
  }
  if (report.aggregates.mustFindHitRate !== undefined
    && report.aggregates.mustFindHitRate !== aggregates.mustFindHitRate) {
    reasons.push("aggregate-mismatch:mustFindHitRate");
  }
  reasons.push(...evidenceReasons(report));
  if (aggregates.cheatDetectedCount > 0) reasons.push("honeypot-void");
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

  if (aggregates.meanNoisePerPositive > criteria.maxMeanNoisePerPositive) {
    reasons.push(`noise-threshold-exceeded:${aggregates.meanNoisePerPositive}>${criteria.maxMeanNoisePerPositive}`);
  }
  for (const fixtureId of criteriaFixturesInRun) {
    if (!incompleteFixtures.has(fixtureId) && aggregates.recallByFixture[fixtureId] !== 1) {
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
