import Ajv from "ajv";
import { createHash } from "node:crypto";
import { fixtureSetSha256 } from "./fixture-catalog";
import type { QualityRate } from "./qualification";
import type { DrawFinding, FixtureSpec, Report } from "./types";

type Campaign = { readonly broad: Report; readonly deep: Report };
type FindingIdentity = { readonly fixtureId: string; readonly draw: number; readonly findingIndex: number };
type Adjudication = FindingIdentity & (
  | { readonly decision: "actionable"; readonly defectId: string }
  | { readonly decision: "false_positive" }
  | { readonly decision: "unresolved"; readonly reason: string }
);
export interface PhaseTwoQualityOracle {
  readonly schemaVersion: 1;
  readonly identity: ReturnType<typeof phaseTwoOracleIdentity>;
  readonly adjudication: { readonly author: string; readonly provenance: string; readonly rows: readonly Adjudication[] };
  readonly severityGold: null | {
    readonly author: string;
    readonly provenance: string;
    readonly frozenAt: string;
    readonly labels: readonly {
      readonly fixtureId: string;
      readonly defectId: string;
      readonly acceptedSeverities: readonly DrawFinding["severity"][];
    }[];
  };
}

export function phaseTwoOracleIdentity(campaign: Campaign, specs: readonly FixtureSpec[]) {
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return { broadSha256: digest(campaign.broad), deepSha256: digest(campaign.deep), fixtureSetSha256: fixtureSetSha256(specs) };
}

const text = { type: "string", minLength: 1, pattern: "\\S" };
const index = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
function object(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
const findingIdentity = { fixtureId: text, draw: index, findingIndex: index };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile<PhaseTwoQualityOracle>(object({
  schemaVersion: { const: 1 },
  identity: object({ broadSha256: hash, deepSha256: hash, fixtureSetSha256: hash }),
  adjudication: object({ author: text, provenance: text, rows: { type: "array", items: { oneOf: [
    object({ ...findingIdentity, decision: { const: "actionable" }, defectId: text }),
    object({ ...findingIdentity, decision: { const: "false_positive" } }),
    object({ ...findingIdentity, decision: { const: "unresolved" }, reason: text }),
  ] } } }),
  severityGold: { anyOf: [{ type: "null" }, object({
    author: text, provenance: text, frozenAt: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$" },
    labels: { type: "array", items: object({ fixtureId: text, defectId: text, acceptedSeverities: {
      type: "array", minItems: 1, uniqueItems: true, items: { enum: ["P0", "P1", "P2", "P3"] },
    } }) },
  })] },
}));

export function measureIndependentQuality(campaign: Campaign, specs: readonly FixtureSpec[], input?: unknown): {
  actionablePrecision: QualityRate; severityCalibration: QualityRate; severityLabelCoverage: QualityRate;
  diagnostics: readonly string[];
} {
  if (input === undefined) return {
    actionablePrecision: { status: "unknown", reason: "independent actionable TP/FP adjudication is absent" },
    severityCalibration: { status: "unknown", reason: "gold severity labels are absent" },
    severityLabelCoverage: { status: "unknown", reason: "gold severity labels are absent" },
    diagnostics: [],
  };
  if (!validate(input)) throw new Error(`invalid Phase 2 quality oracle: ${ajv.errorsText(validate.errors)}`);
  const identity = phaseTwoOracleIdentity(campaign, specs);
  for (const key of ["broadSha256", "deepSha256", "fixtureSetSha256"] as const) {
    if (input.identity[key] !== identity[key]) throw new Error(`Phase 2 quality oracle identity mismatch: ${key}`);
  }
  const ids = new Set(specs.filter((spec) => spec.kind === "positive" || spec.kind === "negative").map((spec) => spec.id));
  const draws = campaign.broad.results.filter((draw) => ids.has(draw.fixtureId));
  const slots = new Map(draws.map((draw) => [JSON.stringify([draw.fixtureId, draw.draw]), draw]));
  const rows = new Map<string, Adjudication>();
  const defects = new Set<string>();
  for (const row of input.adjudication.rows) {
    const draw = slots.get(JSON.stringify([row.fixtureId, row.draw]));
    if (!draw?.findings || row.findingIndex >= draw.findings.length) throw new Error("Phase 2 quality oracle references an unknown finding");
    const key = JSON.stringify([row.fixtureId, row.draw, row.findingIndex]);
    if (rows.has(key)) throw new Error("duplicate Phase 2 quality oracle finding");
    rows.set(key, row);
    if (row.decision === "actionable") {
      const defect = JSON.stringify([row.fixtureId, row.draw, row.defectId]);
      if (defects.has(defect)) throw new Error("duplicate actionable defect in Phase 2 draw");
      defects.add(defect);
    }
  }
  const labels = new Map<string, readonly DrawFinding["severity"][]>();
  if (input.severityGold !== null) {
    const frozen = Date.parse(input.severityGold.frozenAt);
    if (!Number.isFinite(frozen) || new Date(frozen).toISOString().replace(".000Z", "Z") !== input.severityGold.frozenAt.replace(".000Z", "Z") ||
      [campaign.broad, campaign.deep].some((report) => !Number.isFinite(Date.parse(report.createdAt)) || frozen >= Date.parse(report.createdAt))) {
      throw new Error("Phase 2 gold severity must be frozen before both reports");
    }
    for (const label of input.severityGold.labels) {
      if (!ids.has(label.fixtureId)) throw new Error("foreign Phase 2 gold severity fixture");
      const key = JSON.stringify([label.fixtureId, label.defectId]);
      if (labels.has(key)) throw new Error("duplicate Phase 2 gold severity identity");
      labels.set(key, label.acceptedSeverities);
    }
  }
  let total = 0;
  let actionable = 0;
  let calibrated = 0;
  let labeled = 0;
  const negativeIds = new Set(specs.filter((spec) => spec.kind === "negative").map((spec) => spec.id));
  const diagnostics = new Set<string>();
  let incomplete = false;
  for (const draw of draws) {
    if (draw.findings === undefined) incomplete = true;
    for (const [findingIndex, finding] of (draw.findings ?? []).entries()) {
      total++;
      const row = rows.get(JSON.stringify([draw.fixtureId, draw.draw, findingIndex]));
      if (!row || row.decision === "unresolved") {
        incomplete = true;
      } else if (row.decision === "actionable") {
        actionable++;
        const accepted = labels.get(JSON.stringify([row.fixtureId, row.defectId]));
        if (accepted) {
          labeled++;
          if (accepted.includes(finding.severity)) calibrated++;
        }
        if (negativeIds.has(draw.fixtureId) && draw.score.falsePositive) {
          diagnostics.add(`independent actionable finding conflicts with negative false-positive proxy: ${draw.fixtureId} draw ${draw.draw}`);
        }
      }
    }
  }
  const unknown: QualityRate = { status: "unknown", reason: "missing or unresolved independent finding adjudication" };
  return {
    actionablePrecision: incomplete ? unknown : total === 0
      ? { status: "unknown", reason: "no emitted findings" }
      : { status: "measured", value: actionable / total, numerator: actionable, denominator: total },
    severityCalibration: incomplete ? unknown : actionable === 0
      ? { status: "unknown", reason: "no actionable findings" }
      : labeled === 0 ? { status: "unknown", reason: "no independently labeled actionable findings" }
      : { status: "measured", value: calibrated / labeled, numerator: calibrated, denominator: labeled },
    severityLabelCoverage: incomplete ? unknown : actionable === 0
      ? { status: "unknown", reason: "no actionable findings" }
      : { status: "measured", value: labeled / actionable, numerator: labeled, denominator: actionable },
    diagnostics: [...diagnostics],
  };
}
