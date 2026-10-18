import Ajv, { type ValidateFunction } from "ajv";
import { importManifest, sha256, type ExternalManifest, type ReviewerInput } from "./manifest.js";
import { isRepositoryPath, maxRepositoryPathLength } from "./path.js";

type Binding = { manifestSHA256: string; reviewerSHA256: string };
type Location = { path: string; side: "base" | "head"; start: number; end: number };
type Finding = { id: string; description: string; location: Location };
type NeedlefishFinding = { id: string; title: string; whyItBreaks: string; file: string; lineStart: number; lineEnd: number; side: "base" | "head" };
type CodexFinding = { id: string; title: string; body: string; code_location: { file: string; side: "base" | "head"; start: number; end: number } };
type RabbitFinding = { id: string; body: string; path: string; side: "LEFT" | "RIGHT"; start_line: number; line: number };
type Product = {
  name: "Needlefish" | "Codex review" | "CodeRabbit";
  version: string;
  configurationSHA256: string;
  source: { identity: string; sha256: string };
};
type Incomplete = { id: string; status: "operational" | "incomplete" | "skipped" | "truncated" | "raw"; reason: string };
type Completed = { id: string; status: "completed" } & (
  { format: "needlefish-capture-v1"; findings: NeedlefishFinding[] } |
  { format: "codex-review-capture-v1"; findings: CodexFinding[] } |
  { format: "coderabbit-capture-v1"; findings: RabbitFinding[] }
);
export type ProductResults = { schemaVersion: 1; binding: Binding; product: Product; attempts: (Completed | Incomplete)[] };
type Gold = { id: string; description: string; location: Location };
type Adjudication = {
  findingId: string;
  descriptionGoldIds: string[];
  unmatched: "legitimate" | "false_positive" | "unresolved";
  rationale: string;
};
export type Evaluator = {
  schemaVersion: 1;
  binding: Binding;
  independent: { identity: string; version: string; sourceSHA256: string };
  gold: { status: "unavailable"; reason: string } | { status: "ready"; provenance: string; findings: Gold[] };
  attempts: { id: string; attemptSHA256: string; adjudications: Adjudication[] }[];
};

const ajv = new Ajv({ strict: true, allErrors: true });
const text = { type: "string", minLength: 1, maxLength: 20_000, pattern: "\\S" };
const id = { type: "string", pattern: "^[A-Za-z0-9._-]+$", maxLength: 200 };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const line = { type: "integer", minimum: 1, maximum: 10_000_000 };
const path = { type: "string", maxLength: maxRepositoryPathLength };
const side = { enum: ["base", "head"] };
function object(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
function array(items: unknown, maxItems = 1000) { return { type: "array", maxItems, items }; }
const binding = object({ manifestSHA256: hash, reviewerSHA256: hash });
const location = object({ path, side, start: line, end: line });
const attemptIdentity = { id, status: { const: "completed" } };
const validateResults = ajv.compile<ProductResults>(object({
  schemaVersion: { const: 1 }, binding,
  product: object({ name: { enum: ["Needlefish", "Codex review", "CodeRabbit"] }, version: text, configurationSHA256: hash, source: object({ identity: text, sha256: hash }) }),
  attempts: { ...array({ oneOf: [
    object({ ...attemptIdentity, format: { const: "needlefish-capture-v1" }, findings: array(object({ id, title: text, whyItBreaks: text, file: path, lineStart: line, lineEnd: line, side })) }),
    object({ ...attemptIdentity, format: { const: "codex-review-capture-v1" }, findings: array(object({ id, title: text, body: text, code_location: object({ file: path, side, start: line, end: line }) })) }),
    object({ ...attemptIdentity, format: { const: "coderabbit-capture-v1" }, findings: array(object({ id, body: text, path, side: { enum: ["LEFT", "RIGHT"] }, start_line: line, line })) }),
    object({ id, status: { enum: ["operational", "incomplete", "skipped", "truncated", "raw"] }, reason: text }),
  ] }, 100), minItems: 1 },
}));
const validateEvaluator = ajv.compile<Evaluator>(object({
  schemaVersion: { const: 1 }, binding,
  independent: object({ identity: text, version: text, sourceSHA256: hash }),
  gold: { oneOf: [
    object({ status: { const: "unavailable" }, reason: text }),
    object({ status: { const: "ready" }, provenance: text, findings: array(object({ id, description: text, location })) }),
  ] },
  attempts: array(object({ id, attemptSHA256: hash, adjudications: array(object({ findingId: id, descriptionGoldIds: { ...array(id), uniqueItems: true }, unmatched: { enum: ["legitimate", "false_positive", "unresolved"] }, rationale: text })) }), 100),
}));

export const maxResultBytes = 2_000_000;
function parse<T>(bytes: string, validate: ValidateFunction<T>, kind: string): T {
  if (Buffer.byteLength(bytes) > maxResultBytes) throw new Error(`${kind}_too_large`);
  const value: unknown = JSON.parse(bytes);
  if (!validate(value)) throw new Error(`invalid_${kind}: ${ajv.errorsText(validate.errors)}`);
  return value;
}
function unique(ids: string[], kind: string): void {
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate_${kind}`);
}
function checkLocation(value: Location): void {
  if (value.end < value.start || !isRepositoryPath(value.path)) throw new Error("invalid_location");
}
export function normalizeFindings(attempt: Completed): Finding[] {
  switch (attempt.format) {
    case "needlefish-capture-v1": return attempt.findings.map((f) => ({ id: f.id, description: `${f.title}\n${f.whyItBreaks}`, location: { path: f.file, side: f.side, start: f.lineStart, end: f.lineEnd } }));
    case "codex-review-capture-v1": return attempt.findings.map((f) => ({ id: f.id, description: `${f.title}\n${f.body}`, location: { path: f.code_location.file, side: f.code_location.side, start: f.code_location.start, end: f.code_location.end } }));
    case "coderabbit-capture-v1": return attempt.findings.map((f) => ({ id: f.id, description: f.body, location: { path: f.path, side: f.side === "LEFT" ? "base" : "head", start: f.start_line, end: f.line } }));
  }
}
const productFormats = { Needlefish: "needlefish-capture-v1", "Codex review": "codex-review-capture-v1", CodeRabbit: "coderabbit-capture-v1" };
export function parseProductResults(bytes: string): ProductResults {
  const value = parse(bytes, validateResults, "product_results");
  unique(value.attempts.map((a) => a.id), "attempt");
  for (const attempt of value.attempts) {
    if (attempt.status !== "completed") continue;
    if (attempt.format !== productFormats[value.product.name]) throw new Error("product_format_mismatch");
    const findings = normalizeFindings(attempt);
    unique(findings.map((f) => f.id), "finding");
    findings.forEach((f) => checkLocation(f.location));
  }
  return value;
}
export function parseEvaluator(bytes: string): Evaluator {
  const value = parse(bytes, validateEvaluator, "evaluator");
  unique(value.attempts.map((a) => a.id), "evaluator_attempt");
  if (value.gold.status === "ready") {
    unique(value.gold.findings.map((g) => g.id), "gold");
    value.gold.findings.forEach((g) => checkLocation(g.location));
  }
  for (const attempt of value.attempts) unique(attempt.adjudications.map((a) => a.findingId), "adjudication");
  return value;
}
export function sourceBinding(manifest: ExternalManifest, reviewer: ReviewerInput): Binding {
  return { manifestSHA256: sha256(JSON.stringify(manifest)), reviewerSHA256: sha256(JSON.stringify(reviewer)) };
}
export function attemptSHA256(attempt: ProductResults["attempts"][number]): string { return sha256(JSON.stringify(attempt)); }

function sameBinding(a: Binding, b: Binding): boolean { return a.manifestSHA256 === b.manifestSHA256 && a.reviewerSHA256 === b.reviewerSHA256; }
function inSnapshot(location: Location, reviewer: ReviewerInput, lineCounts: Map<string, number>): boolean {
  const key = `${location.side}:${location.path}`;
  let lines = lineCounts.get(key);
  if (lines === undefined) {
    const file = (location.side === "head" ? reviewer.headFiles : reviewer.baseFiles).find((f) => f.path === location.path);
    if (!file) return false;
    lines = Number(file.content.length > 0 && !file.content.endsWith("\n"));
    for (let i = file.content.indexOf("\n"); i !== -1; i = file.content.indexOf("\n", i + 1)) lines++;
    lineCounts.set(key, lines);
  }
  return location.end <= lines;
}
function atGold(actual: Location, accepted: Location): boolean {
  return actual.path === accepted.path && actual.side === accepted.side && actual.start >= accepted.start && actual.end <= accepted.end;
}
function allocate(findings: Finding[], gold: Gold[], judgments: Adjudication[]) {
  const assigned = new Map<string, string>();
  const byGold = new Map(gold.map((g) => [g.id, g]));
  const byFinding = new Map(judgments.map((a) => [a.findingId, a]));
  const candidates = new Map(findings.map((finding) => [finding.id, (byFinding.get(finding.id)?.descriptionGoldIds ?? []).filter((id) => {
    const accepted = byGold.get(id);
    return accepted !== undefined && atGold(finding.location, accepted.location);
  })]));
  function assign(findingId: string, seen: Set<string>): boolean {
    for (const goldId of candidates.get(findingId) ?? []) {
      if (seen.has(goldId)) continue;
      seen.add(goldId);
      const previous = assigned.get(goldId);
      if (previous === undefined || assign(previous, seen)) { assigned.set(goldId, findingId); return true; }
    }
    return false;
  }
  for (const finding of findings) assign(finding.id, new Set());
  return {
    matches: [...assigned].map(([goldId, findingId]) => ({ findingId, goldId })),
    candidateFindingIds: new Set([...candidates].filter(([, ids]) => ids.length > 0).map(([findingId]) => findingId)),
  };
}

export function scoreProductResults(manifest: ExternalManifest, evaluator: Evaluator, results: ProductResults, repo?: string) {
  const admitted = importManifest(manifest, repo);
  const identity = { schemaVersion: 1, rubric: "external-description-location-v2", instanceId: manifest.source.instanceId, product: results.product, binding: results.binding, evaluator: evaluator.independent, evaluatorSHA256: sha256(JSON.stringify(evaluator)), resultsSHA256: sha256(JSON.stringify(results)) };
  if (admitted.status === "excluded") return { ...identity, status: "excluded", reasons: admitted.reasons, attempts: results.attempts.map((a) => ({ id: a.id, attemptSHA256: attemptSHA256(a), status: "excluded", originalStatus: a.status, ...(a.status === "completed" ? {} : { originalReason: a.reason }), metrics: null })) };
  const expected = sourceBinding(manifest, admitted.reviewer);
  if (!sameBinding(results.binding, expected) || !sameBinding(evaluator.binding, expected)) throw new Error("source_identity_mismatch");
  const gold = evaluator.gold;
  const lineCounts = new Map<string, number>();
  if (gold.status === "ready" && gold.findings.some((g) => !inSnapshot(g.location, admitted.reviewer, lineCounts))) throw new Error("gold_location_outside_snapshot");
  for (const judged of evaluator.attempts) {
    const original = results.attempts.find((a) => a.id === judged.id);
    if (!original || original.status !== "completed" || attemptSHA256(original) !== judged.attemptSHA256) throw new Error("evaluator_attempt_identity_mismatch");
    const findingIds = new Set(original.findings.map((f) => f.id));
    for (const a of judged.adjudications) {
      if (!findingIds.has(a.findingId)) throw new Error("foreign_adjudication_finding");
      if (a.descriptionGoldIds.some((id) => gold.status !== "ready" || !gold.findings.some((g) => g.id === id))) throw new Error("foreign_adjudication_gold");
    }
  }
  const attempts = results.attempts.map((attempt) => {
    const attemptIdentity = { id: attempt.id, attemptSHA256: attemptSHA256(attempt) };
    if (attempt.status !== "completed") return { ...attemptIdentity, status: attempt.status, reason: attempt.reason, metrics: null };
    if (gold.status === "unavailable") return { ...attemptIdentity, status: "unscorable", reason: gold.reason, metrics: null };
    const findings = normalizeFindings(attempt);
    const judgments = evaluator.attempts.find((a) => a.id === attempt.id)?.adjudications ?? [];
    if (findings.some((f) => !judgments.some((a) => a.findingId === f.id))) return { ...attemptIdentity, status: "unscorable", reason: "incomplete_independent_adjudication", metrics: null };
    const { matches, candidateFindingIds } = allocate(findings, gold.findings, judgments);
    const duplicate = candidateFindingIds.size - matches.length;
    const unmatched = findings.filter((f) => !candidateFindingIds.has(f.id));
    const falsePositive = unmatched.filter((f) => judgments.find((a) => a.findingId === f.id)?.unmatched === "false_positive").length;
    const legitimateUnmatched = unmatched.filter((f) => judgments.find((a) => a.findingId === f.id)?.unmatched === "legitimate").length;
    const unresolved = unmatched.length - falsePositive - legitimateUnmatched;
    const actionable = matches.length + legitimateUnmatched;
    return { ...attemptIdentity, status: "completed", matches, metrics: {
      matched: matches.length, missed: gold.findings.length - matches.length, duplicate, falsePositive, legitimateUnmatched, unresolved,
      findingCount: findings.length, goldCount: gold.findings.length,
      recall: { numerator: matches.length, denominator: gold.findings.length, value: gold.findings.length ? matches.length / gold.findings.length : null },
      precision: { numerator: actionable, denominator: findings.length, value: findings.length && unresolved === 0 ? actionable / findings.length : null },
    } };
  });
  return { ...identity, status: "evaluated", attempts };
}
