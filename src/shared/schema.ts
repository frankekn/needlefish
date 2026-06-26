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

export function normalizeFinding(raw: any): Finding {
  if (!raw || typeof raw !== "object") {
    throw new Error("malformed finding: not an object");
  }
  const sev = String(raw.severity ?? "").trim().toUpperCase();
  if (!SEVERITIES.includes(sev as Severity)) {
    throw new Error(`malformed finding: invalid severity "${raw.severity}"`);
  }
  const cat = String(raw.category ?? "").trim();
  if (!CATEGORIES.includes(cat as Category)) {
    throw new Error(`malformed finding: invalid category "${raw.category}"`);
  }
  const file = String(raw.file ?? "").trim();
  if (!file) throw new Error("malformed finding: missing file");
  const title = String(raw.title ?? "").trim();
  if (!title) throw new Error("malformed finding: missing title");
  const whyItBreaks = String(raw.whyItBreaks ?? "").trim();
  if (!whyItBreaks) throw new Error("malformed finding: missing whyItBreaks");
  const suggestedFix = String(raw.suggestedFix ?? "").trim();
  if (!suggestedFix) throw new Error("malformed finding: missing suggestedFix");
  const lineStart = Number(raw.lineStart);
  if (!Number.isFinite(lineStart) || lineStart <= 0) {
    throw new Error(`malformed finding: invalid lineStart ${raw.lineStart}`);
  }
  const lineEnd = Number(raw.lineEnd ?? raw.lineStart);
  if (!Number.isFinite(lineEnd) || lineEnd <= 0) {
    throw new Error(`malformed finding: invalid lineEnd ${raw.lineEnd}`);
  }
  return {
    severity: sev as Severity,
    category: cat as Category,
    file,
    title,
    whyItBreaks,
    suggestedFix,
    lineStart,
    lineEnd,
    confidence: Math.max(0, Math.min(1, Number(raw.confidence ?? 0))),
    validation: String(raw.validation ?? ""),
  };
}

export function normalizeReview(raw: any, strict = true): RawReview {
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
  const findings = strict
    ? raw.findings.map(normalizeFinding)
    : raw.findings
        .map((f: any) => {
          try {
            return normalizeFinding(f);
          } catch {
            return null;
          }
        })
        .filter((f: Finding | null): f is Finding => f !== null);
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
