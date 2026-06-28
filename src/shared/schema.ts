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
  readonly verdict: Verdict;
  readonly summary: string;
  readonly findings: readonly Finding[];
  readonly checked: readonly string[];
  readonly residualRisks: readonly ResidualRisk[];
  readonly baseSha: string;
  readonly headSha: string;
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
