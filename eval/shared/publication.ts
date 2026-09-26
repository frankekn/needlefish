import type { DrawResult, Expected, FixtureKind, Report } from "./types";

export const REPO_URL = "https://github.com/frankekn/needlefish";
export const MAX_MEAN_NOISE_PER_POSITIVE = 0.12;

export interface LaneConfig {
  readonly report: string;
  readonly name: string;
  readonly runner: Report["runner"];
  readonly model: string;
  readonly effort: string;
  readonly status: "Deployed" | "Candidate";
  readonly legacyConfigIdentityException?: string;
  readonly legacyAuthIdentityException?: string;
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
  readonly fixtureIds: readonly string[];
  readonly fixtureKinds: Readonly<Record<string, FixtureKind>>;
  readonly fixtureTiers: Readonly<Record<string, number>>;
  readonly fixtureDefectClasses?: Readonly<Record<string, string>>;
  readonly fixtureSetHash: string;
  readonly promptHash: string;
  readonly expectedByFixture?: Readonly<Record<string, Expected>>;
  readonly fastPathFixtureIds?: readonly string[];
}

export type PublishedReport = Report & {
  readonly fixtureKinds?: Readonly<Record<string, FixtureKind>>;
  readonly provider?: string;
  readonly route?: string;
  readonly runnerVersion?: string;
  readonly invocation?: string;
  readonly reproductionCommand?: string;
  readonly runnerEnvironment?: string;
  readonly privateEnvironment?: boolean;
};

type PublishedDraw = DrawResult & { readonly operationalFailure?: unknown };

// RunnerTimeoutError (src/shared/runner-process.ts) message: the runner used its whole
// per-call deadline. In production that is a review the author never receives, so it
// is scored as a failed review of the model, not as an infrastructure failure. The
// draw is already scored as a miss with invalid output; only its publication status
// changes. Idle timeouts, spawn errors, crashes, and rate limits stay operational.
// The command is interpolated verbatim and may contain spaces; the space before
// ETIMEDOUT keeps EIDLETIMEDOUT out.
const RUNNER_DEADLINE_TIMEOUT = /^spawn .+ ETIMEDOUT$/;

export function operationalFailures(report: PublishedReport): string[] {
  return report.results.flatMap((result) => {
    const failure = (result as PublishedDraw).operationalFailure;
    if (failure === undefined) return [];
    if (typeof failure !== "string" || failure.trim().length === 0) {
      throw new Error("operational failure must be a non-empty string");
    }
    if (RUNNER_DEADLINE_TIMEOUT.test(failure)) return [];
    return [failure];
  });
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

export function tierRecall(report: PublishedReport, tier: 1 | 2 | 3): number {
  if (!report.fixtureTiers) throw new Error("fixture tiers are required");
  let total = 0;
  let hits = 0;
  for (const result of report.results) {
    if (report.fixtureTiers[result.fixtureId] !== tier) continue;
    if (report.fixtureKinds?.[result.fixtureId] !== "positive") {
      throw new Error(`Tier-${tier} fixture is not positive: ${result.fixtureId}`);
    }
    total += 1;
    if (result.score.recall) hits += 1;
  }
  if (total === 0) throw new Error(`Tier-${tier} draws are required`);
  return hits / total;
}

export interface TierOneInterimGate {
  readonly hits: number;
  readonly total: number;
  readonly passed: boolean;
  readonly perFixture: Readonly<Record<string, { readonly hits: number; readonly total: number }>>;
}

export function tierOneInterimGate(report: PublishedReport): TierOneInterimGate {
  if (!report.fixtureTiers) throw new Error("fixture tiers are required");
  const byFixture = new Map<string, { hits: number; total: number }>();
  for (const result of report.results) {
    if (report.fixtureTiers[result.fixtureId] !== 1) continue;
    const bucket = byFixture.get(result.fixtureId) ?? { hits: 0, total: 0 };
    bucket.total += 1;
    if (result.score.recall) bucket.hits += 1;
    byFixture.set(result.fixtureId, bucket);
  }
  const perFixture = Object.fromEntries(
    [...byFixture.entries()].sort(([a], [b]) => a.localeCompare(b)),
  );
  const total = [...byFixture.values()].reduce((sum, value) => sum + value.total, 0);
  const hits = [...byFixture.values()].reduce((sum, value) => sum + value.hits, 0);
  const passed =
    total === 21 &&
    hits >= 20 &&
    [...byFixture.values()].every((value) => value.total === 3 && value.hits >= 2);
  return { hits, total, passed, perFixture };
}

export function displayedMetrics(report: PublishedReport): {
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly invalidJsonRate: number;
  readonly verdictMatchRate: number;
  readonly meanDurationMs: number;
  readonly meanNoisePerPositive: number;
} {
  const { recall, falsePositiveRate } = reviewRates(report);
  const positives = report.results.filter(
    (result) => report.fixtureKinds?.[result.fixtureId] === "positive",
  );
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
    meanNoisePerPositive:
      positives.reduce((sum, result) => sum + result.score.noiseFindingCount, 0) /
      positives.length,
  };
}

export function sameRecord(
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

export function scoreConfidenceInterval(report: PublishedReport): readonly [number, number] {
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

export function compareLanes(a: Lane, b: Lane): number {
  const aMetrics = displayedMetrics(a.report);
  const bMetrics = displayedMetrics(b.report);
  return (
    balancedReviewAccuracy(b.report) - balancedReviewAccuracy(a.report) ||
    bMetrics.recall - aMetrics.recall ||
    aMetrics.falsePositiveRate - bMetrics.falsePositiveRate
  );
}

