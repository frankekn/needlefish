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
  path: string;
  surface: Surface;
}

export interface PrMeta {
  number: number;
  title: string;
  body: string | null;
  comments: string[];
  reviews: string[];
  checks: { name: string; status: string; conclusion: string | null }[];
}

export interface Bundle {
  repoPath: string;
  baseSha: string;
  headSha: string;
  patch: string;
  changedFiles: ChangedFile[];
  agentsMd: string | null;
  prMeta: PrMeta | null;
  deep: boolean;
  focus: string | null;
}

export interface Finding {
  severity: Severity;
  title: string;
  category: Category;
  file: string;
  lineStart: number;
  lineEnd: number;
  confidence: number;
  whyItBreaks: string;
  suggestedFix: string;
  validation: string;
}

export interface ResidualRisk {
  text: string;
  blocks: boolean;
}

export interface RawReview {
  summary: string;
  findings: Finding[];
  checked: string[];
  residual_risks: ResidualRisk[];
}

export interface ReviewResult {
  verdict: Verdict;
  summary: string;
  findings: Finding[];
  checked: string[];
  residualRisks: ResidualRisk[];
  baseSha: string;
  headSha: string;
}

const SEVERITIES: Severity[] = ["P0", "P1", "P2", "P3"];
const CATEGORIES: Category[] = [
  "bug",
  "contract",
  "duplicate",
  "runtime",
  "security",
  "validation",
];

export function normalizeFinding(raw: Partial<Finding>): Finding {
  const sev = String(raw.severity ?? "").trim().toUpperCase();
  return {
    severity: (SEVERITIES.includes(sev as Severity) ? sev : "P1") as Severity,
    title: String(raw.title ?? "Untitled finding").slice(0, 120),
    category: (CATEGORIES.includes(raw.category as Category)
      ? raw.category
      : "bug") as Category,
    file: String(raw.file ?? ""),
    lineStart: Number(raw.lineStart ?? 0),
    lineEnd: Number(raw.lineEnd ?? raw.lineStart ?? 0),
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
    whyItBreaks: String(raw.whyItBreaks ?? ""),
    suggestedFix: String(raw.suggestedFix ?? ""),
    validation: String(raw.validation ?? ""),
  };
}

export function normalizeReview(raw: any): RawReview {
  if (!raw || typeof raw !== "object") {
    throw new Error("malformed review output: not an object");
  }
  if (typeof raw.summary !== "string") {
    throw new Error("malformed review output: summary missing or not a string");
  }
  if (!Array.isArray(raw.findings)) {
    throw new Error("malformed review output: findings missing or not an array");
  }
  if (!Array.isArray(raw.checked)) {
    throw new Error("malformed review output: checked missing or not an array");
  }
  if (!Array.isArray(raw.residual_risks)) {
    throw new Error(
      "malformed review output: residual_risks missing or not an array"
    );
  }
  const findings = raw.findings.map(normalizeFinding);
  const residual = raw.residual_risks.map((r: any) => ({
    text: String(r?.text ?? ""),
    blocks: Boolean(r?.blocks),
  }));
  return {
    summary: raw.summary,
    findings,
    checked: raw.checked.map(String),
    residual_risks: residual,
  };
}
