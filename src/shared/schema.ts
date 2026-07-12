import type { RunStat } from "./runner.js";

export const REVIEW_RESULT_SCHEMA_VERSION = 1;

export type Severity = "P0" | "P1" | "P2" | "P3";

export type Category =
  | "bug"
  | "contract"
  | "duplicate"
  | "runtime"
  | "security"
  | "validation";

export type Surface =
  | "public-api"
  | "cli"
  | "config"
  | "schema"
  | "workflow"
  | "dependency"
  | "test"
  | "docs"
  | "source";

export type Verdict = "pass" | "changes_requested" | "needs_human";

export interface ChangedFile {
  readonly path: string;
  readonly surface: Surface;
}

export interface PrMeta {
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly comments: readonly string[];
  readonly reviews: readonly string[];
  readonly checks: readonly { readonly name: string; readonly status: string; readonly conclusion: string | null }[];
}

export interface Bundle {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly patch: string;
  readonly patchStat: string;
  readonly changedFiles: readonly ChangedFile[];
  readonly reviewTarget?: string;
  readonly agentsMd: string;
  readonly prMeta: PrMeta | null;
  readonly deep: boolean;
  readonly focus: string | null;
}

export interface Finding {
  readonly severity: Severity;
  readonly title: string;
  readonly category: Category;
  readonly file: string;
  readonly lineStart: number;
  readonly lineEnd: number;
  readonly confidence: number;
  readonly whyItBreaks: string;
  readonly suggestedFix: string;
  readonly validation: string;
  readonly consumerFile?: string;
  readonly consumerLine?: number;
  readonly replacement?: { readonly lines: readonly string[] };
}

export interface ResidualRisk {
  readonly text: string;
  readonly blocks: boolean;
}

export interface RawReview {
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly checked: readonly string[];
  readonly residual_risks: readonly ResidualRisk[];
}

export interface ReviewResult {
  readonly schemaVersion: typeof REVIEW_RESULT_SCHEMA_VERSION;
  readonly verdict: Verdict;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly checked: readonly string[];
  readonly residualRisks: readonly ResidualRisk[];
  readonly baseSha: string;
  readonly headSha: string;
  readonly reviewTarget?: string;
  readonly stats?: readonly RunStat[];
  readonly totalDurationMs?: number;
  // Eval-only tracing: the candidate findings as they stood BEFORE runCritic.
  // Populated only when NEEDLEFISH_EVAL_TRACE is set; never shipped to users.
  readonly candidateFindings?: readonly Finding[];
  // Eval-only tracing: raw model outputs from swallowed pass failures (deep
  // passes), preserved so the canary scan can inspect them. Trace-gated.
  readonly failedRawOutputs?: readonly string[];
  // Eval-only tracing: raw model outputs of every SUCCESSFUL pass attempt.
  // Some pass text is consumed but never retained in the final result (map
  // hotspot why/edges, critic-pruned residuals) — the canary scan needs the
  // full transcript. Trace-gated.
  readonly rawOutputs?: readonly string[];
}

export function serializeReviewResult(result: ReviewResult): string {
  const json = JSON.stringify(result, null, 2);
  if (!json) throw new Error("ReviewResult serialization failed");
  return `${json}\n`;
}

export interface RiskEdge {
  readonly producer: string;
  readonly consumerFile: string;
  readonly consumerLine: number;
  readonly why: string;
}

export interface Hotspot {
  readonly name: string;
  readonly files: readonly string[];
  readonly why: string;
  readonly risk: "high" | "med" | "low";
  readonly edges: readonly RiskEdge[];
}

export interface MapResult {
  readonly summary: string;
  readonly hotspots: readonly Hotspot[];
}
