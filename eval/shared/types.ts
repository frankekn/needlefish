import type { Category, Verdict } from "../../src/shared/schema";
import type { RunnerName } from "../../src/shared/runner";

export type FixtureKind = "positive" | "negative" | "parity";

export interface MatchSpec {
  readonly pattern: string;
  readonly category?: Category;
}

export interface Expected {
  readonly verdict: Verdict;
  readonly mustFind?: readonly MatchSpec[];
  readonly mustNotFind?: readonly MatchSpec[];
  readonly noBlockingFindings?: boolean;
  readonly anchorFile?: string;
  readonly anchorLineRange?: readonly [number, number];
}

export interface FixtureSpec {
  readonly id: string;
  readonly kind: FixtureKind;
  readonly defectClass: string;
  readonly description: string;
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly headFiles: Readonly<Record<string, string>>;
  readonly expected: Expected;
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
}

export interface Report {
  readonly promptHash: string;
  readonly runner: RunnerName;
  readonly model: string | null;
  readonly effort: string | null;
  readonly draws: number;
  readonly createdAt: string;
  readonly baseline: boolean;
  readonly results: readonly DrawResult[];
  readonly aggregates: Aggregates;
}
