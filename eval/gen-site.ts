import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureSetHash as computeFixtureSetHash, loadFixtures } from "./run";
import { isCompleteReport } from "./shared/report-completeness";
import {
  hasConsistentCheatDetection,
  hasCurrentScorer,
} from "./shared/report-integrity";
import {
  ANTICHEAT_VERSION,
  type FixtureKind,
  type FixtureSpec,
  type Report,
} from "./shared/types";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(EVAL_DIR);
const MANIFEST_PATH = path.join(EVAL_DIR, "leaderboard.json");
const OUTPUT_PATH = path.join(REPO_ROOT, "docs", "index.html");
const REPO_URL = "https://github.com/frankekn/needlefish";

export interface LaneConfig {
  readonly report: string;
  readonly name: string;
  readonly provider: string;
  readonly route: string;
  readonly runnerVersion: string;
  readonly status: "Deployed" | "Candidate";
}

export interface BlockedConfig {
  readonly name: string;
  readonly model: string;
  readonly provider: string;
  readonly reason: string;
}

export interface ExcludedConfig extends BlockedConfig {
  readonly report: string;
}

export interface LeaderboardManifest {
  readonly updated: string;
  readonly baseline: string;
  readonly lanes: readonly LaneConfig[];
  readonly blocked: readonly BlockedConfig[];
  readonly excluded?: readonly ExcludedConfig[];
}

export interface Lane {
  readonly config: LaneConfig;
  readonly report: PublishedReport;
}

export interface FixtureClassifications {
  readonly fixtureKinds: Readonly<Record<string, FixtureKind>>;
  readonly fixtureTiers: Readonly<Record<string, number>>;
  readonly fixtureSetHash: string;
}

type PublishedReport = Report & {
  readonly fixtureKinds?: Readonly<Record<string, FixtureKind>>;
};

export function fixtureClassifications(
  specs: readonly FixtureSpec[],
): FixtureClassifications {
  return {
    fixtureKinds: Object.fromEntries(specs.map((spec) => [spec.id, spec.kind])),
    fixtureTiers: Object.fromEntries(
      specs
        .filter((spec) => spec.kind === "positive")
        .map((spec) => [spec.id, spec.tier ?? 2]),
    ),
    fixtureSetHash: computeFixtureSetHash(specs),
  };
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function percent(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`;
}

function reviewRates(report: PublishedReport): {
  readonly recall: number;
  readonly specificity: number;
  readonly falsePositiveRate: number;
} {
  if (!report.fixtureKinds) throw new Error("fixture kinds are required");
  let positives = 0;
  let truePositives = 0;
  let negatives = 0;
  let trueNegatives = 0;
  let falsePositives = 0;
  for (const result of report.results) {
    const kind = report.fixtureKinds[result.fixtureId];
    if (kind === "positive") {
      positives += 1;
      if (result.score.recall) truePositives += 1;
    } else if (kind === "negative") {
      negatives += 1;
      if (result.score.falsePositive) falsePositives += 1;
      if (result.score.formatOk && !result.score.falsePositive) {
        trueNegatives += 1;
      }
    } else if (kind !== "parity" && kind !== "honeypot") {
      throw new Error(`fixture kind is missing for ${result.fixtureId}`);
    }
  }
  if (positives === 0 || negatives === 0) {
    throw new Error("positive and negative draws are required");
  }
  return {
    recall: truePositives / positives,
    specificity: trueNegatives / negatives,
    falsePositiveRate: falsePositives / negatives,
  };
}

export function balancedReviewAccuracy(report: PublishedReport): number {
  const { recall, specificity } = reviewRates(report);
  return (recall + specificity) / 2;
}

export function usableSpecificity(report: PublishedReport): number {
  return reviewRates(report).specificity;
}

function tierOneRecall(report: PublishedReport): number {
  if (!report.fixtureTiers) throw new Error("fixture tiers are required");
  let total = 0;
  let hits = 0;
  for (const result of report.results) {
    if (report.fixtureTiers[result.fixtureId] !== 1) continue;
    if (report.fixtureKinds?.[result.fixtureId] !== "positive") {
      throw new Error(`Tier-1 fixture is not positive: ${result.fixtureId}`);
    }
    total += 1;
    if (result.score.recall) hits += 1;
  }
  if (total === 0) throw new Error("Tier-1 draws are required");
  return hits / total;
}

function displayedMetrics(report: PublishedReport): {
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly invalidJsonRate: number;
  readonly verdictMatchRate: number;
  readonly meanDurationMs: number;
} {
  const { recall, falsePositiveRate } = reviewRates(report);
  return {
    recall,
    falsePositiveRate,
    invalidJsonRate:
      report.results.filter((result) => !result.score.formatOk).length /
      report.results.length,
    verdictMatchRate:
      report.results.filter((result) => result.score.verdictMatch).length /
      report.results.length,
    meanDurationMs:
      report.results.reduce((sum, result) => sum + result.durationMs, 0) /
      report.results.length,
  };
}

function sameRecord(
  left: Readonly<Record<string, unknown>> | undefined,
  right: Readonly<Record<string, unknown>> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return (
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) /
    (values.length - 1)
  );
}

function fixtureOutcomes(
  report: PublishedReport,
  kind: "positive" | "negative",
): number[] {
  if (!report.fixtures || !report.fixtureKinds) {
    throw new Error("fixture manifest and kinds are required");
  }
  return report.fixtures
    .filter((fixtureId) => report.fixtureKinds?.[fixtureId] === kind)
    .sort()
    .map((fixtureId) => {
      const draws = report.results.filter((result) => result.fixtureId === fixtureId);
      return mean(
        draws.map((result) =>
          kind === "positive"
            ? Number(result.score.recall)
            : Number(result.score.formatOk && !result.score.falsePositive),
        ),
      );
    });
}

function scoreStandardError(report: PublishedReport): number {
  const positives = fixtureOutcomes(report, "positive");
  const negatives = fixtureOutcomes(report, "negative");
  return (
    0.5 *
    Math.sqrt(
      sampleVariance(positives) / positives.length +
      sampleVariance(negatives) / negatives.length,
    )
  );
}

function scoreConfidenceInterval(report: PublishedReport): readonly [number, number] {
  const score = balancedReviewAccuracy(report);
  const margin = 1.96 * scoreStandardError(report);
  return [Math.max(0, score - margin), Math.min(1, score + margin)];
}

function statisticallyTied(left: PublishedReport, right: PublishedReport): boolean {
  const leftPositive = fixtureOutcomes(left, "positive");
  const rightPositive = fixtureOutcomes(right, "positive");
  const leftNegative = fixtureOutcomes(left, "negative");
  const rightNegative = fixtureOutcomes(right, "negative");
  const positiveDifferences = leftPositive.map(
    (value, index) => value - rightPositive[index],
  );
  const negativeDifferences = leftNegative.map(
    (value, index) => value - rightNegative[index],
  );
  const standardError =
    0.5 *
    Math.sqrt(
      sampleVariance(positiveDifferences) / positiveDifferences.length +
      sampleVariance(negativeDifferences) / negativeDifferences.length,
    );
  return (
    Math.abs(balancedReviewAccuracy(left) - balancedReviewAccuracy(right)) <=
    1.96 * standardError
  );
}

export function statisticalRanks(lanes: readonly Lane[]): number[] {
  // Statistical non-separation is not transitive. Anchor each point-sorted
  // group to its highest-scoring lane so bridge lanes cannot collapse the
  // entire leaderboard into one rank.
  let groupStart = 0;
  return lanes.map((lane, index) => {
    if (index > 0 && !statisticallyTied(lanes[groupStart].report, lane.report)) {
      groupStart = index;
    }
    return groupStart + 1;
  });
}

function compareLanes(a: Lane, b: Lane): number {
  const aMetrics = displayedMetrics(a.report);
  const bMetrics = displayedMetrics(b.report);
  return (
    balancedReviewAccuracy(b.report) - balancedReviewAccuracy(a.report) ||
    bMetrics.recall - aMetrics.recall ||
    aMetrics.falsePositiveRate - bMetrics.falsePositiveRate
  );
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const field = value[key];
  if (typeof field !== "string" || field.trim().length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function blockedConfig(value: unknown, label: string): BlockedConfig {
  const item = record(value, label);
  return {
    name: requiredString(item, "name", label),
    model: requiredString(item, "model", label),
    provider: requiredString(item, "provider", label),
    reason: requiredString(item, "reason", label),
  };
}

export function validateManifest(value: unknown): LeaderboardManifest {
  const manifest = record(value, "leaderboard manifest");
  if (!Array.isArray(manifest.lanes) || manifest.lanes.length === 0) {
    throw new Error("leaderboard manifest.lanes must be a non-empty array");
  }
  if (!Array.isArray(manifest.blocked)) {
    throw new Error("leaderboard manifest.blocked must be an array");
  }
  if (manifest.excluded !== undefined && !Array.isArray(manifest.excluded)) {
    throw new Error("leaderboard manifest.excluded must be an array");
  }
  const lanes = manifest.lanes.map((value, index): LaneConfig => {
    const label = `leaderboard manifest.lanes[${index}]`;
    const lane = record(value, label);
    const status = lane.status;
    if (status !== "Deployed" && status !== "Candidate") {
      throw new Error(`${label}.status must be Deployed or Candidate`);
    }
    return {
      report: requiredString(lane, "report", label),
      name: requiredString(lane, "name", label),
      provider: requiredString(lane, "provider", label),
      route: requiredString(lane, "route", label),
      runnerVersion: requiredString(lane, "runnerVersion", label),
      status,
    };
  });
  if (lanes.filter((lane) => lane.status === "Deployed").length > 1) {
    throw new Error("leaderboard manifest must not contain multiple deployed lanes");
  }
  if (new Set(lanes.map((lane) => lane.report)).size !== lanes.length) {
    throw new Error("leaderboard manifest lane report paths must be unique");
  }
  return {
    updated: requiredString(manifest, "updated", "leaderboard manifest"),
    baseline: requiredString(manifest, "baseline", "leaderboard manifest"),
    lanes,
    blocked: manifest.blocked.map((value, index) =>
      blockedConfig(value, `leaderboard manifest.blocked[${index}]`),
    ),
    excluded: (manifest.excluded as unknown[] | undefined)?.map(
      (value, index) => {
        const label = `leaderboard manifest.excluded[${index}]`;
        return {
          ...blockedConfig(value, label),
          report: requiredString(record(value, label), "report", label),
        };
      },
    ),
  };
}

function readManifest(): LeaderboardManifest {
  const parsed: unknown = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
  return validateManifest(parsed);
}

function readLane(config: LaneConfig): Lane {
  const reportPath = path.join(EVAL_DIR, config.report);
  return {
    config,
    report: JSON.parse(readFileSync(reportPath, "utf8")) as PublishedReport,
  };
}

function validateLane(lane: Lane): void {
  const { config, report } = lane;
  const fail = (reason: string): never => {
    throw new Error(`${config.report}: ${reason}`);
  };
  if (
    ![config.name, config.provider, config.route, config.runnerVersion].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    fail("display name, provider, route, and runner version are required");
  }
  if (!isCompleteReport(report)) fail("report is incomplete");
  if (report.gateClass !== "R") fail("public lanes require gate class R");
  if (report.draws !== 3) fail("public lanes require exactly 3 draws");
  if (report.holdout !== "include") fail("holdouts must be included");
  if (report.anticheatVersion !== ANTICHEAT_VERSION) {
    fail(`anticheatVersion must be ${ANTICHEAT_VERSION}`);
  }
  if (!hasCurrentScorer(report)) fail("scorer hash is stale or missing");
  if (!hasConsistentCheatDetection(report)) fail("anti-cheat counts are inconsistent");
  if (report.aggregates.cheatDetectedCount !== 0) fail("anti-cheat detection fired");
  if (!report.runner || !report.model || !report.effort || !report.gitSha) {
    fail("runner, model, effort, and git SHA are required");
  }
  if (!report.createdAt || Number.isNaN(Date.parse(report.createdAt))) {
    fail("a valid creation date is required");
  }
  if (!report.promptHash || !report.fixtureSetHash || !report.scorerHash) {
    fail("prompt, fixture-set, and scorer hashes are required");
  }
  if (!report.fixtureKinds) fail("fixture kinds are required");
  if (!report.fixtureTiers) fail("fixture tiers are required");
  for (const rawResult of report.results as readonly unknown[]) {
    if (typeof rawResult !== "object" || rawResult === null) {
      fail("draw result must be an object");
    }
    const score = (rawResult as { score?: unknown }).score;
    if (typeof score !== "object" || score === null) {
      fail("draw score must be an object");
    }
    for (const field of [
      "recall",
      "falsePositive",
      "formatOk",
      "verdictMatch",
    ] as const) {
      if (typeof (score as Record<string, unknown>)[field] !== "boolean") {
        fail(`draw score ${field} must be boolean`);
      }
    }
    const typedScore = score as Record<string, boolean>;
    if (
      !typedScore.formatOk &&
      (typedScore.recall || typedScore.falsePositive || typedScore.verdictMatch)
    ) {
      fail("invalid draw must not claim a successful outcome");
    }
    const durationMs = (rawResult as { durationMs?: unknown }).durationMs;
    if (
      typeof durationMs !== "number" ||
      !Number.isFinite(durationMs) ||
      durationMs < 0
    ) {
      fail("draw duration must be a finite non-negative number");
    }
  }
  for (const [name, value] of [
    ["recall", report.aggregates.recall],
    ["Tier-1 recall", report.aggregates.recallByTier?.t1],
    ["false-positive rate", report.aggregates.falsePositiveRate],
    ["invalid-output rate", report.aggregates.invalidJsonRate],
    ["verdict-match rate", report.aggregates.verdictMatchRate],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      fail(`${name} must be a finite rate from 0 to 1`);
    }
  }
  if (Math.abs(report.aggregates.recallByTier.t1 - tierOneRecall(report)) > 1e-12) {
    fail("Tier-1 recall does not match draw results");
  }
  const derived = displayedMetrics(report);
  for (const [name, stored, computed] of [
    ["recall", report.aggregates.recall, derived.recall],
    ["false-positive rate", report.aggregates.falsePositiveRate, derived.falsePositiveRate],
    ["invalid-output rate", report.aggregates.invalidJsonRate, derived.invalidJsonRate],
    ["verdict-match rate", report.aggregates.verdictMatchRate, derived.verdictMatchRate],
    ["mean duration", report.aggregates.meanDurationMs, derived.meanDurationMs],
  ] as const) {
    if (Math.abs(stored - computed) > 1e-12) {
      fail(`${name} does not match draw results`);
    }
  }
  if (
    typeof report.aggregates.meanDurationMs !== "number" ||
    !Number.isFinite(report.aggregates.meanDurationMs) ||
    report.aggregates.meanDurationMs < 0
  ) {
    fail("mean duration must be a finite non-negative number");
  }
}

function validateComparability(
  lanes: readonly Lane[],
  baselinePath: string,
  canonical: FixtureClassifications,
): Lane {
  for (const lane of lanes) validateLane(lane);
  const baseline = lanes.find(({ config }) => config.report === baselinePath);
  if (!baseline) throw new Error(`baseline is not a configured lane: ${baselinePath}`);
  for (const lane of lanes) {
    if (!isCompleteReport(lane.report, baseline.report.fixtures)) {
      throw new Error(
        `${lane.config.report}: fixture manifest does not match the baseline`,
      );
    }
    if (
      !sameRecord(lane.report.fixtureKinds, canonical.fixtureKinds) ||
      !sameRecord(lane.report.fixtureTiers, canonical.fixtureTiers)
    ) {
      throw new Error(
        `${lane.config.report}: fixture classifications do not match the fixture specs`,
      );
    }
    if (lane.report.fixtureSetHash !== canonical.fixtureSetHash) {
      throw new Error(
        `${lane.config.report}: fixtureSetHash does not match the current fixture specs`,
      );
    }
    for (const field of ["promptHash", "fixtureSetHash", "scorerHash", "anticheatVersion"] as const) {
      if (lane.report[field] !== baseline.report[field]) {
        throw new Error(`${lane.config.report}: ${field} does not match the baseline`);
      }
    }
  }
  return baseline;
}

function rawUrl(report: string): string {
  return `${REPO_URL}/blob/main/eval/${report}`;
}

function chart(lanes: readonly Lane[]): string {
  if (lanes.length < 3) return "";
  const width = 760;
  const height = 330;
  const left = 68;
  const right = 24;
  const top = 32;
  const bottom = 54;
  const recalls = lanes.map(({ report }) => displayedMetrics(report).recall);
  const xMin = Math.max(0, Math.min(...recalls) - 0.05);
  const yMax = Math.max(
    0.02,
    ...lanes.map(({ report }) => displayedMetrics(report).falsePositiveRate),
  );
  const x = (value: number) => left + ((value - xMin) / (1 - xMin)) * (width - left - right);
  const y = (value: number) => top + (value / yMax) * (height - top - bottom);
  const points = lanes
    .map(({ config, report }, index) => {
      const metrics = displayedMetrics(report);
      const px = x(metrics.recall);
      const py = y(metrics.falsePositiveRate);
      const anchor = px > width - 170 ? "end" : "start";
      const dx = anchor === "end" ? -12 : 12;
      return `<g><circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="7" class="point point-${index}"/><text x="${(px + dx).toFixed(1)}" y="${(py - 10).toFixed(1)}" text-anchor="${anchor}">${escapeHtml(config.name)}</text></g>`;
    })
    .join("");
  return `<figure class="plot" aria-labelledby="plot-title"><figcaption id="plot-title">Catch more defects, block fewer clean changes</figcaption><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Anchored recall against false-positive rate. Farther right and higher is better."><line x1="${left}" y1="${top}" x2="${left}" y2="${height - bottom}"/><line x1="${left}" y1="${height - bottom}" x2="${width - right}" y2="${height - bottom}"/><text x="${left}" y="${height - 16}">Lower recall</text><text x="${width - right}" y="${height - 16}" text-anchor="end">Higher recall</text><text x="18" y="${top}" transform="rotate(-90 18 ${top})" text-anchor="end">Fewer false positives</text>${points}</svg><p>Horizontal position is anchored recall. Higher position means a lower false-positive rate. The table remains canonical.</p></figure>`;
}

function laneRows(lanes: readonly Lane[], ranked: boolean): string {
  const ranks = ranked ? statisticalRanks(lanes) : [];
  return lanes
    .map(({ config, report }, index) => {
      const metrics = displayedMetrics(report);
      const t1 = tierOneRecall(report);
      const tierOneMiss = t1 !== undefined && t1 < 1;
      const rank = ranked ? String(ranks[index]) : "—";
      const status = tierOneMiss ? "Disqualified: Tier-1 miss" : config.status;
      const [lower, upper] = scoreConfidenceInterval(report);
      return `<tr><td class="rank">${rank}</td><th scope="row"><details><summary>${escapeHtml(config.name)}</summary><dl><div><dt>Exact model</dt><dd><code>${escapeHtml(report.model)}</code></dd></div><div><dt>Harness</dt><dd>${escapeHtml(config.runnerVersion)}</dd></div><div><dt>Runner ID</dt><dd><code>${escapeHtml(report.runner)}</code></dd></div><div><dt>Route</dt><dd>${escapeHtml(config.route)}</dd></div><div><dt>Run</dt><dd><time datetime="${escapeHtml(report.createdAt)}">${escapeHtml(report.createdAt.slice(0, 10))}</time> · ${report.fixtures?.length} fixtures × ${report.draws} draws · ${escapeHtml(report.holdout)} holdouts · anti-cheat v${report.anticheatVersion}</dd></div><div><dt>Git SHA</dt><dd><code>${escapeHtml(report.gitSha)}</code></dd></div><div><dt>Hashes</dt><dd><code>${escapeHtml(report.promptHash)} / ${escapeHtml(report.fixtureSetHash)} / ${escapeHtml(report.scorerHash)}</code></dd></div></dl><a href="${rawUrl(config.report)}">Raw ${escapeHtml(config.name)} ${escapeHtml(report.effort)} report</a></details></th><td class="number strong">${percent(balancedReviewAccuracy(report), 2)}</td><td class="number">${percent(lower)}–${percent(upper)}</td><td><span class="status status-${tierOneMiss ? "disqualified" : config.status.toLowerCase()}">${escapeHtml(status)}</span></td><td class="number">${percent(metrics.recall)}</td><td class="number">${percent(usableSpecificity(report))}</td><td class="number">${t1 === undefined ? "—" : percent(t1)}</td><td class="number">${percent(metrics.falsePositiveRate)}</td><td class="number">${percent(metrics.invalidJsonRate)}</td><td>${escapeHtml(config.runnerVersion)}</td><td class="route"><strong>${escapeHtml(config.provider)}</strong><small>${escapeHtml(config.route)}</small></td><td><code>${escapeHtml(report.effort)}</code></td><td class="number">${Math.round(metrics.meanDurationMs / 1000)}s</td></tr>`;
    })
    .join("");
}

function laneTable(lanes: readonly Lane[], label: string, ranked: boolean): string {
  return `<div class="table-wrap" role="region" aria-label="${escapeHtml(label)}" tabindex="0"><table><thead><tr><th>Rank</th><th>Model</th><th class="number">Balanced score</th><th class="number">95% CI</th><th>Status</th><th class="number">Recall</th><th class="number">Usable specificity</th><th class="number">Tier-1</th><th class="number">False positive</th><th class="number">Invalid</th><th>Harness</th><th>Provider / route</th><th>Effort</th><th class="number">Mean time</th></tr></thead><tbody>${laneRows(lanes, ranked)}</tbody></table></div>`;
}

function blockedRows(blocked: readonly BlockedConfig[]): string {
  return blocked
    .map(({ name, model, provider, reason }) => `<li><strong>${escapeHtml(name)}</strong><code>${escapeHtml(model)}</code><span>${escapeHtml(provider)}</span><p>${escapeHtml(reason)}</p></li>`)
    .join("");
}

function excludedRows(excluded: readonly ExcludedConfig[]): string {
  return excluded
    .map(({ name, model, provider, reason, report }) => `<li><strong>${escapeHtml(name)}</strong><code>${escapeHtml(model)}</code><span>${escapeHtml(provider)}</span><p>${escapeHtml(reason)} <a href="${rawUrl(report)}">Raw ${escapeHtml(name)} report</a></p></li>`)
    .join("");
}

export function renderSite(
  manifest: LeaderboardManifest,
  configured: readonly Lane[],
  canonical: FixtureClassifications,
): string {
  validateManifest(manifest);
  const baseline = validateComparability(configured, manifest.baseline, canonical);
  const qualified = configured
    .filter(({ report }) => tierOneRecall(report) === 1)
    .sort(compareLanes);
  const disqualified = configured
    .filter(({ report }) => tierOneRecall(report) !== 1)
    .sort(compareLanes);
  const fixtureCount = baseline.report.fixtures?.length ?? 0;
  const deployment = configured.find(({ config }) => config.status === "Deployed");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Needlefish benchmark: which model and review harness catches real pull-request defects without blocking clean changes?">
<meta name="theme-color" content="#071f2b">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cpath fill='%23071f2b' d='M8 8h48v48H8z'/%3E%3Cpath fill='%23bdebf1' d='M18 46V18h6l16 18V18h6v28h-6L24 28v18z'/%3E%3C/svg%3E">
<meta property="og:title" content="Needlefish benchmark">
<meta property="og:description" content="Which AI reviewer catches real pull-request bugs without blocking clean changes?">
<meta property="og:type" content="website">
<meta property="og:image" content="https://raw.githubusercontent.com/frankekn/needlefish/main/assets/banner.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="Needlefish benchmark">
<meta name="twitter:description" content="Which AI reviewer catches real pull-request bugs without blocking clean changes?">
<meta name="twitter:image" content="https://raw.githubusercontent.com/frankekn/needlefish/main/assets/banner.png">
<title>Needlefish benchmark</title>
<style>
:root{color-scheme:light;--ink:#071f2b;--muted:#49636d;--paper:#f5f7f3;--white:#fff;--cyan:#bdebf1;--blue:#0c5670;--orange:#c44724;--line:#bfd0d2;--focus:#c44724;font-family:"Avenir Next","Segoe UI",sans-serif;font-synthesis:none}@font-face{font-family:Newsreader;src:url("./fonts/Newsreader.woff2") format("woff2");font-style:normal;font-weight:200 800;font-display:swap}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;color:var(--ink);background:var(--paper);line-height:1.55}::selection{background:var(--cyan);color:var(--ink)}a{color:var(--blue);text-underline-offset:.18em}a:hover{text-decoration-thickness:2px}a:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:4px;border-radius:3px}.shell{width:min(1180px,calc(100% - 40px));margin:auto}.mast{min-height:88vh;padding:28px 0 72px;background:var(--ink);color:var(--white);position:relative;overflow:hidden}.mast:after{content:"";position:absolute;inset:auto 0 0;height:13px;background:linear-gradient(90deg,var(--cyan) 0 54%,var(--orange) 54% 57%,transparent 57%)}nav{display:flex;align-items:center;justify-content:space-between;gap:24px;font-size:.9rem}.brand{color:var(--white);font-weight:800;letter-spacing:.08em;text-decoration:none;text-transform:uppercase}.navlinks{display:flex;gap:20px;flex-wrap:wrap}.navlinks a{color:#d8e7e8}.hero{display:grid;grid-template-columns:minmax(0,1.5fr) minmax(260px,.7fr);gap:clamp(40px,8vw,110px);align-items:end;padding-top:clamp(80px,14vh,150px)}h1{font-family:Newsreader,Georgia,serif;font-size:clamp(3.4rem,9vw,6rem);font-weight:600;letter-spacing:-.04em;line-height:.86;max-width:8ch;margin:0}.lede{font-size:clamp(1.1rem,2vw,1.45rem);max-width:34ch;color:#d8e7e8;margin:28px 0 0}.dive-log{border-top:1px solid #53707a;padding-top:20px}.dive-log strong{display:block;font:700 clamp(2rem,4vw,3.2rem)/1 ui-monospace,SFMono-Regular,monospace;font-variant-numeric:tabular-nums}.dive-log span{display:block;color:#afc7cb;margin-top:8px}.trust{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#31505a;margin-top:72px;border:1px solid #31505a}.trust div{background:var(--ink);padding:18px}.trust b{display:block;font:700 1.35rem/1 ui-monospace,SFMono-Regular,monospace}.trust span{display:block;color:#afc7cb;font-size:.82rem;margin-top:8px}.section{padding:88px 0}.section h2{font-family:Newsreader,Georgia,serif;font-size:clamp(2.2rem,5vw,4rem);font-weight:600;letter-spacing:-.035em;line-height:1;margin:0 0 18px}.intro{max-width:70ch;color:var(--muted);font-size:1.08rem;margin:0 0 36px}.decision{display:grid;grid-template-columns:1fr 2fr;gap:40px;padding:24px 0 46px;border-bottom:1px solid var(--line)}.decision strong{font-size:1rem;line-height:1.3;color:var(--ink)}.decision p{margin:0;font-size:1.2rem}.table-hint{display:none;color:var(--muted);font-size:.85rem}.table-wrap{overflow-x:auto;border-top:2px solid var(--ink);border-bottom:2px solid var(--ink);background:var(--white);scrollbar-color:var(--blue) #dce9e7;scrollbar-width:thin}.table-wrap::-webkit-scrollbar{height:10px}.table-wrap::-webkit-scrollbar-track{background:#dce9e7}.table-wrap::-webkit-scrollbar-thumb{background:var(--blue);border:2px solid #dce9e7;border-radius:8px}table{width:100%;border-collapse:collapse;min-width:1120px;font-variant-numeric:tabular-nums}th,td{padding:16px 13px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}thead th{font-size:.75rem;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);background:#edf2ef}tbody tr:last-child>*{border-bottom:0}.rank{font:700 1.15rem/1 ui-monospace,SFMono-Regular,monospace;color:var(--muted)}summary{cursor:pointer;font-weight:750;color:var(--ink)}details[open] summary{color:var(--blue)}details[open] dl,details[open] summary~a{animation:reveal .18s ease-out}@keyframes reveal{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}details dl{font-size:.82rem;margin:14px 0}details dl div{display:grid;grid-template-columns:80px 1fr;gap:8px;margin:5px 0}dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}.number{text-align:right}.strong{font-weight:800}.route small{display:block;max-width:18ch;color:var(--muted);margin-top:4px}.status{display:inline-block;padding:4px 9px;border-radius:999px;font-size:.74rem;font-weight:800;border:1px solid currentColor}.status-production{color:#0c684f}.status-candidate{color:#8b3e24}.plot{margin:48px 0 0;padding:28px;background:var(--white);border:1px solid var(--line)}.plot figcaption{font-size:1.2rem;line-height:1.2;font-weight:800}.plot svg{display:block;width:100%;margin-top:20px;overflow:visible}.plot svg line{stroke:var(--line);stroke-width:1}.plot svg text{font:600 13px "Avenir Next","Segoe UI",sans-serif;fill:var(--muted)}.plot .point{fill:var(--blue);stroke:var(--white);stroke-width:3}.plot .point-0{fill:var(--orange)}.plot p{color:var(--muted);font-size:.85rem;margin:8px 0 0}.blocked{list-style:none;margin:0;padding:0;border-top:2px solid var(--ink)}.blocked li{display:grid;grid-template-columns:1fr 1fr 1fr;gap:18px;padding:20px 0;border-bottom:1px solid var(--line)}.blocked code{font-size:.82rem}.blocked p{grid-column:2/-1;margin:0;color:var(--muted)}.method{display:grid;grid-template-columns:minmax(220px,.55fr) 1fr;gap:60px}.method h3{font-size:1rem;text-transform:uppercase;letter-spacing:.08em;margin:0 0 14px}.method p,.method li{max-width:72ch}.method ul{padding-left:1.2rem}.hashes{font-size:.84rem;color:var(--muted);overflow-wrap:anywhere}footer{padding:34px 0 60px;border-top:1px solid var(--line);display:flex;justify-content:space-between;gap:24px;color:var(--muted);font-size:.9rem}
.status-deployed{color:#0c684f}
@media(max-width:760px){.shell{width:min(100% - 24px,1180px)}.mast{min-height:auto}.hero,.decision,.method{grid-template-columns:1fr}.hero{padding-top:72px}.trust{grid-template-columns:1fr 1fr}.section{padding:64px 0}.blocked li{grid-template-columns:1fr}.blocked p{grid-column:1}.navlinks{justify-content:flex-end;gap:12px}.table-hint{display:block}.plot{display:none}footer{flex-direction:column}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}details[open] dl,details[open] summary~a{animation:none}}
.skip{position:absolute;z-index:2;top:12px;left:12px;padding:10px 14px;background:var(--white);transform:translateY(-200%)}.skip:focus{transform:none}.table-wrap:focus-visible{outline:3px solid var(--focus);outline-offset:4px}
</style>
</head>
<body><!--
THESIS: A public marine observation bulletin makes benchmark evidence the product and refuses marketing cards before results.
OWN-WORLD: Deep-ocean ink, paper white, cyan data lines, orange exceptions, editorial serif headlines, plain sans copy, and monospace only for measurements.
STORY: A visitor learns what Needlefish tests, sees the comparable lanes, understands blocked routes, and can inspect the evidence.
FIRST VIEWPORT: A sparse mast pairs one oversized question with the 86 × 3 protocol; trust facts form the lower rail and the leaderboard follows immediately.
FORM: Code-led leaderboard-first bulletin, selected from the ranked structural set; seed 6ba00010.
FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
-->
<a class="skip" href="#leaderboard">Skip to leaderboard</a>
<header class="mast"><div class="shell"><nav aria-label="Primary"><a class="brand" href="${REPO_URL}">Needlefish</a><div class="navlinks"><a href="#leaderboard">Leaderboard</a><a href="#method">Method</a><a href="${REPO_URL}/tree/main/eval/results">Raw reports</a><a href="${REPO_URL}">Use Needlefish</a></div></nav><div class="hero"><div><h1>Which AI reviewer catches real bugs?</h1><p class="lede">Needlefish measures which model and review setup finds real pull-request defects without blocking clean changes. Every lane reviews the same guarded scenarios three times, and every score links to raw evidence.</p></div><div class="dive-log"><strong>${fixtureCount} × 3</strong><span>review scenarios × independent draws</span></div></div><div class="trust" aria-label="Benchmark trust facts"><div><b>${fixtureCount}</b><span>current fixtures</span></div><div><b>3</b><span>draws per lane</span></div><div><b>sealed</b><span>holdouts included</span></div><div><b>v${ANTICHEAT_VERSION}</b><span>anti-cheat generation</span></div></div></div></header>
<main><section class="section" id="leaderboard"><div class="shell"><h2>Current leaderboard</h2><p class="intro">A lane is the complete combination of model, agent harness, provider route, and effort. Balanced Review Accuracy gives equal weight to anchored recall and usable specificity. Tier-1 recall is a hard gate.</p><div class="decision"><strong>Current deployment</strong><p>${deployment ? tierOneRecall(deployment.report) === 1 ? `${escapeHtml(deployment.config.name)} via ${escapeHtml(deployment.config.provider)} is deployed and passes the current Tier-1 gate.` : `${escapeHtml(deployment.config.name)} via ${escapeHtml(deployment.config.provider)} is deployed but misses the current Tier-1 gate. Release 0.4.2 is blocked until this lane is re-qualified or a qualified replacement is selected.` : "No deployed lane is configured."}</p></div><p class="table-hint">Scroll horizontally to see every metric.</p>${laneTable(qualified, "Qualified model leaderboard", true)}${chart(qualified)}</div></section>
${disqualified.length ? `<section class="section"><div class="shell"><h2>Disqualified</h2><p class="intro">These complete reports missed at least one Tier-1 defect. Their balanced scores remain visible, but they receive no rank.</p>${laneTable(disqualified, "Disqualified model lanes", false)}</div></section>` : ""}
<section class="section"><div class="shell"><h2>Not run</h2><p class="intro">Unavailable routes are shown as blocked, never converted into a zero score.</p><ul class="blocked">${blockedRows(manifest.blocked)}</ul></div></section>
${manifest.excluded?.length ? `<section class="section"><div class="shell"><h2>Not ranked</h2><p class="intro">Compromised or operationally invalid reports remain visible as evidence but never enter the leaderboard.</p><ul class="blocked">${excludedRows(manifest.excluded)}</ul></div></section>` : ""}
<section class="section" id="method"><div class="shell method"><div><h2>How to read it</h2><p class="hashes">Updated ${escapeHtml(manifest.updated)}<br>prompt ${escapeHtml(baseline.report.promptHash)}<br>fixtures ${escapeHtml(baseline.report.fixtureSetHash)}<br>scorer ${escapeHtml(baseline.report.scorerHash)}</p></div><div><h3>Balanced Review Accuracy</h3><p>The primary score is the arithmetic mean of anchored recall and usable specificity. Invalid model output cannot count as a correct positive or negative result, so each unusable draw is counted once. Point-sorted uncertainty groups are anchored to their highest-scoring lane; lower lanes share that rank while their paired 95% normal interval versus the anchor includes zero. This avoids non-transitive bridge comparisons. The table also shows each lane's 95% interval. A Tier-1 miss overrides the score and disqualifies the lane. Verdict match, invalid rate, and speed remain separate diagnostics.</p><h3>Anchored recall</h3><p>A defect counts only when the finding matches the expected behavior and the expected file. Missing a Tier-1 defect disqualifies a lane regardless of its average.</p><h3>False positives</h3><p>Clean fixtures measure whether a reviewer blocks a change that should pass. Lower is better.</p><h3>Integrity</h3><p>Every published lane includes sealed holdouts, a disposable HOME, a planted canary, full-transcript scanning, and post-run repository mutation checks. Provider failures are operational failures, not proof of model quality.</p><h3>Reproduce</h3><p>Read the <a href="${REPO_URL}/blob/main/eval/RESULTS.md">chronological experiment record</a>, inspect each raw report, or run the <a href="${REPO_URL}/tree/main/eval">evaluation harness</a>.</p></div></div></section></main>
<footer class="shell"><span>Needlefish — strict local PR review.</span><span><a href="${REPO_URL}">Use Needlefish</a> · <a href="${REPO_URL}/blob/main/LICENSE">MIT License</a></span></footer>
</body>
</html>`;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const manifest = readManifest();
  const lanes = manifest.lanes.map(readLane);
  const canonical = fixtureClassifications(await loadFixtures(null));
  mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, renderSite(manifest, lanes, canonical));
  process.stderr.write(`wrote ${path.relative(REPO_ROOT, OUTPUT_PATH)} (${lanes.length} lanes)\n`);
}
