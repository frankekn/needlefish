import type {
  Category,
  Finding,
  Hotspot,
  MapResult,
  PrMeta,
  RawReview,
  RiskEdge,
  Severity,
} from "./schema.js";

type JsonRecord = Record<string, unknown>;

function isRecord(raw: unknown): raw is JsonRecord {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function requireRecord(raw: unknown, label: string): JsonRecord {
  if (!isRecord(raw)) {
    throw new Error(`${label}: not an object`);
  }
  return raw;
}

function requireString(raw: JsonRecord, field: string, label: string): string {
  const value = raw[field];
  if (typeof value !== "string") {
    throw new Error(`${label}: ${field} missing or not a string`);
  }
  return value;
}

function requireArray(raw: JsonRecord, field: string, label: string): readonly unknown[] {
  const value = raw[field];
  if (!Array.isArray(value)) {
    throw new Error(`${label}: ${field} missing or not an array`);
  }
  return value;
}

function asString(value: unknown): string {
  return String(value ?? "").trim();
}

function bodyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (isRecord(item) ? asString(item.body) : asString(item)))
    .filter(Boolean);
}

export function normalizeMap(raw: unknown): MapResult {
  const record = requireRecord(raw, "malformed map output");
  if (typeof record.summary !== "string") {
    throw new Error("malformed map output: summary missing");
  }
  const hotspots: Hotspot[] = requireArray(record, "hotspots", "malformed map output")
    .map((item): Hotspot | null => {
      if (!isRecord(item)) return null;
      const files = Array.isArray(item.files) ? item.files.map(String).filter(Boolean) : [];
      if (files.length === 0) return null;
      const risk = item.risk === "high" || item.risk === "med" || item.risk === "low" ? item.risk : "med";
      const edges = Array.isArray(item.edges)
        ? item.edges
            .map((edge): RiskEdge | null => {
              if (!isRecord(edge)) return null;
              const consumerFile = asString(edge.consumerFile);
              if (!consumerFile) return null;
              return {
                producer: asString(edge.producer),
                consumerFile,
                consumerLine: Number(edge.consumerLine ?? 0),
                why: asString(edge.why),
              };
            })
            .filter((edge: RiskEdge | null): edge is RiskEdge => edge !== null)
        : [];
      return {
        name: String(item.name ?? files[0]).slice(0, 80),
        files,
        why: asString(item.why),
        risk,
        edges,
      };
    })
    .filter((hotspot: Hotspot | null): hotspot is Hotspot => hotspot !== null);
  return { summary: record.summary, hotspots };
}

function parseSeverity(raw: unknown): Severity {
  switch (asString(raw).toUpperCase()) {
    case "P0":
      return "P0";
    case "P1":
      return "P1";
    case "P2":
      return "P2";
    case "P3":
      return "P3";
    default:
      throw new Error(`malformed finding: invalid severity "${String(raw)}"`);
  }
}

function parseCategory(raw: unknown): Category {
  switch (asString(raw)) {
    case "bug":
      return "bug";
    case "contract":
      return "contract";
    case "duplicate":
      return "duplicate";
    case "runtime":
      return "runtime";
    case "security":
      return "security";
    case "validation":
      return "validation";
    default:
      throw new Error(`malformed finding: invalid category "${String(raw)}"`);
  }
}

function parseReplacement(raw: unknown): Finding["replacement"] | undefined {
  if (!isRecord(raw)) return undefined;
  const lines = raw.lines;
  if (!Array.isArray(lines) || lines.length === 0) return undefined;
  if (!lines.every((line): line is string => typeof line === "string" && !line.includes("\n") && !line.includes("\r"))) return undefined;
  return { lines };
}

export function normalizeFinding(raw: unknown): Finding {
  const record = requireRecord(raw, "malformed finding");
  const severity = parseSeverity(record.severity);
  const category = parseCategory(record.category);
  const file = asString(record.file);
  if (!file) throw new Error("malformed finding: missing file");
  const title = asString(record.title);
  if (!title) throw new Error("malformed finding: missing title");
  const whyItBreaks = asString(record.whyItBreaks);
  if (!whyItBreaks) throw new Error("malformed finding: missing whyItBreaks");
  const suggestedFix = asString(record.suggestedFix);
  if (!suggestedFix) throw new Error("malformed finding: missing suggestedFix");
  const lineStart = Number(record.lineStart);
  if (!Number.isFinite(lineStart) || lineStart <= 0) {
    throw new Error(`malformed finding: invalid lineStart ${String(record.lineStart)}`);
  }
  const lineEnd = Number(record.lineEnd ?? record.lineStart);
  if (!Number.isFinite(lineEnd) || lineEnd <= 0) {
    throw new Error(`malformed finding: invalid lineEnd ${String(record.lineEnd)}`);
  }
  if (lineEnd < lineStart) {
    throw new Error("malformed finding: lineEnd before lineStart");
  }
  const rawConfidence = Number(record.confidence ?? 0);
  if (!Number.isFinite(rawConfidence)) {
    throw new Error(`malformed finding: invalid confidence ${String(record.confidence)}`);
  }
  const confidence = Math.max(0, Math.min(1, rawConfidence));
  if (severity !== "P3" && confidence < 0.7) {
    throw new Error("malformed finding: blocking finding has low confidence");
  }
  const replacement = parseReplacement(record.replacement);
  return {
    severity,
    category,
    file,
    title,
    whyItBreaks,
    suggestedFix,
    lineStart,
    lineEnd,
    confidence,
    validation: String(record.validation ?? ""),
    consumerFile: record.consumerFile ? asString(record.consumerFile) || undefined : undefined,
    consumerLine: record.consumerLine ? Number(record.consumerLine) || undefined : undefined,
    ...(replacement ? { replacement } : {}),
  };
}

export function normalizeReview(raw: unknown, strict = true): RawReview {
  const record = requireRecord(raw, "malformed review output");
  const summary = requireString(record, "summary", "malformed review output");
  const rawFindings = requireArray(record, "findings", "malformed review output");
  const rawChecked = requireArray(record, "checked", "malformed review output");
  const rawResidual = requireArray(record, "residual_risks", "malformed review output");
  const findings = strict
    ? rawFindings.map(normalizeFinding)
    : rawFindings
        .map((finding) => {
          try {
            return normalizeFinding(finding);
          } catch (err) {
            if (err instanceof Error) return null;
            throw err;
          }
        })
        .filter((finding: Finding | null): finding is Finding => finding !== null);
  const residual = rawResidual.map((risk) => {
    if (!isRecord(risk)) {
      return { text: "", blocks: false };
    }
    const text = String(risk.text ?? "").trim();
    if (!text) {
      throw new Error("malformed review output: residual risk text missing");
    }
    return {
      text,
      blocks: Boolean(risk.blocks),
    };
  });
  return {
    summary,
    findings,
    checked: rawChecked.map(String),
    residual_risks: residual,
  };
}

export function normalizePrMeta(raw: unknown, fallbackNumber?: number): PrMeta {
  const record = requireRecord(raw, "malformed PR metadata");
  const number = Number(record.number ?? fallbackNumber);
  if (!Number.isInteger(number) || number <= 0) {
    throw new Error("malformed PR metadata: invalid number");
  }
  const checks = Array.isArray(record.statusCheckRollup)
    ? record.statusCheckRollup
        .map((check): PrMeta["checks"][number] | null => {
          if (!isRecord(check)) return null;
          return {
            name: asString(check.name || check.context),
            status: asString(check.status),
            conclusion: check.conclusion === null || check.conclusion === undefined ? null : asString(check.conclusion),
          };
        })
        .filter((check: PrMeta["checks"][number] | null): check is PrMeta["checks"][number] => check !== null)
    : [];
  return {
    number,
    title: String(record.title ?? ""),
    body: typeof record.body === "string" ? record.body : null,
    comments: bodyList(record.comments),
    reviews: bodyList(record.reviews),
    checks,
  };
}

export function normalizeBodyList(raw: unknown): string[] {
  return bodyList(raw);
}
