import type { Category, Severity, Verdict } from "../../src/shared/schema";
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
  // The only deletion signal. headFiles overlays the base tree; omission from
  // headFiles means the base file is unchanged, not deleted.
  readonly deletedFiles?: readonly string[];
  readonly renamedFiles?: readonly {
    readonly from: string;
    readonly to: string;
  }[];
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
  // Phase-1 robustness diagnostics are additive only; v1 cheatDetected remains
  // the sole active gate. Absent on legacy and non-traced scores.
  readonly robustness?: AnticheatRobustnessDiagnostics;
  readonly error?: string;
}

export type AnticheatDetectorKind = "canary" | "trap";
export type AnticheatTraceSurface =
  | "raw_success"
  | "raw_failure"
  | "candidate_finding"
  | "candidate_review_text"
  | "final_finding"
  | "final_review_text";
export type AnticheatPassKind = "review" | "map" | "deep" | "critic";
export type AnticheatTraceOutcome =
  | "parsed"
  | "parse_failed"
  | "runner_failed";

export interface AnticheatMatchProvenance {
  readonly detectorKind: AnticheatDetectorKind;
  readonly surface: AnticheatTraceSurface;
  readonly passKind: AnticheatPassKind;
  readonly passIndex: number;
  readonly promptAttempt: number;
  readonly runnerAttempt: number;
  readonly outcome: AnticheatTraceOutcome;
}

export interface AnticheatRobustnessDiagnostics {
  readonly rawExposure: boolean;
  readonly rawExposureCount: number;
  readonly candidateAdoption: boolean;
  readonly candidateAdoptionCount: number;
  readonly criticRecovery: boolean;
  readonly finalReviewTextMarkerLeak: boolean;
  readonly finalReviewTextMarkerLeakCount: number;
  readonly finalFindingMarkerEscape: boolean;
  readonly finalFindingMarkerEscapeCount: number;
  readonly totalMatchedEventCount: number;
  readonly missingProvenanceCount: number;
  readonly matchProvenance: readonly AnticheatMatchProvenance[];
}

// The scored finding, recorded per draw so the gate can re-execute mustFind
// patterns against real ground truth (F2) instead of re-adding score booleans.
// Full text is kept — truncation would break pattern re-matching.
export interface DrawFinding {
  readonly severity: Severity;
  readonly category: Category;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly title: string;
  readonly whyItBreaks: string;
}

// One entry per mustFind spec: the spec's pattern and the index (into the
// draw's `findings`) of the finding that satisfied recall, or null for a miss.
export interface MatchEvidence {
  readonly pattern: string;
  readonly findingIndex: number | null;
}

export interface DrawResult {
  readonly fixtureId: string;
  readonly draw: number;
  readonly score: FixtureScore;
  readonly durationMs: number;
  readonly calls: number;
  readonly retries: number;
  // Ground-truth evidence for the gate's re-execution (F1). Optional because a
  // slot resumed from a pre-F1 report carries none; F3's scorerHash gate
  // refuses to reuse such reports, so fresh reports always populate both.
  readonly findings?: readonly DrawFinding[];
  readonly matchEvidence?: readonly MatchEvidence[];
}

export interface Aggregates {
  readonly recall: number;
  readonly falsePositiveRate: number;
  readonly invalidJsonRate: number;
  readonly verdictMatchRate: number;
  readonly lineAnchorValidRate: number;
  readonly meanDurationMs: number;
  readonly recallByFixture: Readonly<Record<string, number>>;
  readonly mustFindHitRateByFixture?: Readonly<Record<string, number>>;
  readonly mustFindHitRate?: number;
  readonly criticPruneErrorRate: number;
  // Recall per difficulty tier, keys "t1"|"t2"|"t3". Untiered positives
  // (legacy) count as t2.
  readonly recallByTier: Readonly<Record<string, number>>;
  readonly meanNoisePerPositive: number;
  // Draws where a honeypot trap fired. Non-zero = the report is compromised.
  readonly cheatDetectedCount: number;
}

// Bump when the anti-cheat guards change enough that draws from older runs
// are no longer comparable. Every report consumer (resume, compare, weekly,
// generated results) refuses reports from other generations.
export const ANTICHEAT_VERSION = 1;

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
  readonly fixtures?: readonly string[];
  readonly fixtureTiers?: Readonly<Record<string, number>>;
  // Anti-cheat guard generation the draws ran under (1 = ephemeral HOME +
  // bait canary). Absent on reports that predate the guards, that disabled a
  // guard via --env, or whose runner cannot honor one (claude is exempt from
  // HOME isolation, so claude lanes are never certified).
  readonly anticheatVersion?: number;
  // sha256 (16 hex) over the scoring-relevant sources. Two reports are only
  // comparable when both were scored by the same code. Absent on reports that
  // predate F3 — resume/compare/weekly/doc generators refuse those as legacy,
  // never grandfathered.
  readonly scorerHash?: string;
}
