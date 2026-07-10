import type { Category, Verdict } from "../../src/shared/schema";
import type { RunnerName } from "../../src/shared/runner";

// `honeypot` fixtures are clean diffs whose trap keywords exist only in the
// spec file. Any finding matching a trap means the runner read the answer key
// (or the harness leaked it) — the whole report is compromised, not just the
// fixture. They count toward no rate except cheatDetectedCount.
export type FixtureKind = "positive" | "negative" | "parity" | "honeypot";

// Difficulty tier for positives. 1 = blatant (a model missing these is
// disqualified regardless of other scores), 2 = requires reading the logic,
// 3 = cross-file / haystack / multi-bug / concurrency. Tiers are calibrated
// empirically: a tier-3 every model solves gets demoted, and vice versa.
export type FixtureTier = 1 | 2 | 3;

// Holdout filter mode for eval runs. `include` (default) tells the full truth;
// `exclude` hides holdouts during prompt-tuning iteration; `only` runs just
// the sealed holdouts for a final-gate check.
export type HoldoutMode = "include" | "exclude" | "only";

export interface MatchSpec {
  readonly pattern: string;
  readonly category?: Category;
  // File the matching finding must anchor to (suffix match). For recall, a
  // mustFind spec without `file` inherits the fixture-level anchorFile — the
  // pattern and the anchor must be satisfied by the SAME finding, otherwise a
  // keyword-stuffed finding on an unrelated file plus a lucky anchor elsewhere
  // would score as a hit. Multi-bug fixtures set `file` per spec.
  readonly file?: string;
  // When set, the matching finding's lineStart must fall in this range.
  readonly lineRange?: readonly [number, number];
}

export interface Expected {
  readonly verdict: Verdict;
  readonly mustFind?: readonly MatchSpec[];
  // Sibling defects legitimately present in the fixture diff (common in
  // real-history fixtures where one fix commit reverted several bugs at once).
  // A finding matching a mayFind spec is neither required for recall nor
  // counted as noise.
  readonly mayFind?: readonly MatchSpec[];
  readonly mustNotFind?: readonly MatchSpec[];
  readonly noBlockingFindings?: boolean;
  readonly anchorFile?: string;
  readonly anchorLineRange?: readonly [number, number];
  // Honeypot trap patterns: keywords that exist only in this spec file, never
  // in the fixture's base/head files. A finding matching one = cheat.
  readonly trap?: readonly MatchSpec[];
}

export interface FixtureProvenance {
  readonly repo: string;
  readonly pr: number;
  readonly kind: "review-finding" | "post-merge-fix" | "revert" | "clean-negative";
  readonly evidenceUrl?: string;
  readonly fixSha?: string;
}

export interface FixtureSpec {
  readonly id: string;
  readonly kind: FixtureKind;
  readonly defectClass: string;
  readonly description: string;
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly headFiles: Readonly<Record<string, string>>;
  readonly expected: Expected;
  readonly holdout?: boolean;
  // Required on positives (enforced by anchor.test.ts).
  readonly tier?: FixtureTier;
  readonly provenance?: FixtureProvenance;
}

export interface FixtureScore {
  readonly fixtureId: string;
  readonly verdict: Verdict | null;
  readonly verdictMatch: boolean;
  readonly mustFindHits: number;
  readonly mustFindTotal: number;
  readonly recall: boolean;
  readonly falsePositive: boolean;
  readonly lineAnchorValid: boolean;
  readonly formatOk: boolean;
  readonly findingCount: number;
  readonly blockingFindingCount: number;
  // Blocking findings that satisfy no mustFind spec. The precision signal on
  // positives: a runner that sprays 20 findings to luck into recall pays here.
  readonly noiseFindingCount: number;
  readonly criticPruneError: boolean;
  // True when a finding matched a honeypot trap pattern (see FixtureKind).
  readonly cheatDetected: boolean;
  readonly error?: string;
}

export interface DrawResult {
  readonly fixtureId: string;
  readonly draw: number;
  readonly score: FixtureScore;
  readonly durationMs: number;
  readonly calls: number;
  readonly retries: number;
}

export interface Aggregates {
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly invalidJsonRate: number;
  readonly verdictMatchRate: number;
  readonly lineAnchorValidRate: number;
  readonly meanDurationMs: number;
  readonly recallByFixture: Readonly<Record<string, number>>;
  readonly criticPruneErrorRate: number;
  // Recall per difficulty tier, keys "t1"|"t2"|"t3". Untiered positives
  // (legacy) count as t2.
  readonly recallByTier: Readonly<Record<string, number>>;
  readonly meanNoisePerPositive: number;
  // Draws where a honeypot trap fired. Non-zero = the report is compromised.
  readonly cheatDetectedCount: number;
}

export interface Report {
  readonly promptHash: string;
  readonly runner: RunnerName;
  readonly model: string | null;
  readonly effort: string | null;
  readonly draws: number;
  readonly createdAt: string;
  readonly baseline: boolean;
  readonly holdout: HoldoutMode;
  readonly results: readonly DrawResult[];
  readonly aggregates: Aggregates;
  // Optional so reports written before these fields existed still parse.
  readonly gitSha?: string | null;
  readonly fixtureSetHash?: string;
  readonly fixtureTiers?: Readonly<Record<string, number>>;
}
