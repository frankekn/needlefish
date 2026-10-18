import { runnerEnvironmentAttestationError } from "./runner-attestation.js";
import type { RuntimeConfigurationIdentity } from "./runtime-qualification.js";
import { isPublicAttestationLabel } from "./public-runtime-identity.js";

export const QUALIFICATION_POLICY = "public-leaderboard-interim-v1";
export type RuntimeConfigurationQualification =
  | { readonly matchStatus: "tested"; readonly policyVersion: typeof QUALIFICATION_POLICY; readonly reportId: string }
  | { readonly matchStatus: "unqualified"; readonly reason: "missing_report" | "report_not_admitted" | "quality_gate_failed" | "different_configuration" | "unknown_identity" };
export type RuntimeQualification = RuntimeConfigurationQualification | { readonly matchStatus: "unqualified" };
export interface QualificationProof {
  readonly version: 1;
  readonly policyVersion: typeof QUALIFICATION_POLICY;
  readonly reportId: string;
  readonly reportSha256: string;
  readonly identity: RuntimeConfigurationIdentity;
}
export function isPublicReportId(value: unknown): value is string {
  return typeof value === "string" && /^results\/[A-Za-z0-9._-]+\.json$/.test(value) && !value.includes("..") && isPublicAttestationLabel(value, process.env);
}
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseRuntimeQualification(value: unknown): RuntimeQualification {
  if (!record(value)) throw new Error("invalid runtime qualification");
  if (value.matchStatus === "tested" && value.policyVersion === QUALIFICATION_POLICY && isPublicReportId(value.reportId) && Object.keys(value).every(key => ["matchStatus", "policyVersion", "reportId"].includes(key))) return { matchStatus: "tested", policyVersion: QUALIFICATION_POLICY, reportId: value.reportId };
  if (value.matchStatus === "unqualified" && Object.keys(value).every(key => ["matchStatus", "reason"].includes(key))) {
    if (value.reason === undefined) return { matchStatus: "unqualified" };
    if (value.reason === "missing_report" || value.reason === "report_not_admitted" || value.reason === "quality_gate_failed" || value.reason === "different_configuration" || value.reason === "unknown_identity") return { matchStatus: "unqualified", reason: value.reason };
  }
  throw new Error("invalid runtime qualification");
}

export function parseQualificationProof(raw: unknown): QualificationProof {
  if (!record(raw) || raw.version !== 1 || raw.policyVersion !== QUALIFICATION_POLICY || !isPublicReportId(raw.reportId) || typeof raw.reportSha256 !== "string" || !/^[a-f0-9]{64}$/.test(raw.reportSha256) || !record(raw.identity)) throw new Error("invalid qualification proof");
  const identity = raw.identity;
  if (identity.runner !== "codex" || typeof identity.model !== "string" || typeof identity.effort !== "string" || typeof identity.promptHash !== "string" || typeof identity.gitSha !== "string" || !/^[a-f0-9]{40}$/.test(identity.gitSha) || identity.gateClass !== "R" || typeof identity.scorerHash !== "string" || typeof identity.fixtureSetHash !== "string" || typeof identity.anticheatVersion !== "number" || !Number.isSafeInteger(identity.anticheatVersion) || identity.anticheatVersion < 1 || typeof identity.provider !== "string" || typeof identity.route !== "string" || typeof identity.runnerVersion !== "string" || typeof identity.runnerEnvironment !== "string" || identity.privateEnvironment !== false) throw new Error("invalid qualification identity");
  const parsed: RuntimeConfigurationIdentity = { runner: identity.runner, model: identity.model, effort: identity.effort, promptHash: identity.promptHash, gitSha: identity.gitSha, gateClass: identity.gateClass, scorerHash: identity.scorerHash, fixtureSetHash: identity.fixtureSetHash, anticheatVersion: identity.anticheatVersion, provider: identity.provider, route: identity.route, runnerVersion: identity.runnerVersion, runnerEnvironment: identity.runnerEnvironment, privateEnvironment: false };
  if (runnerEnvironmentAttestationError(parsed)) throw new Error("invalid public qualification identity");
  const nativeProof: QualificationProof = { version: 1, policyVersion: QUALIFICATION_POLICY, reportId: raw.reportId, reportSha256: raw.reportSha256, identity: parsed };
  if (!nativeDigestFromProof(nativeProof)) throw new Error("qualification requires a public native Codex artifact");
  return Object.freeze({ version: 1, policyVersion: QUALIFICATION_POLICY, reportId: raw.reportId, reportSha256: raw.reportSha256, identity: Object.freeze(parsed) });
}

export function nativeDigestFromProof(proof: QualificationProof): string | undefined {
  if (proof.identity.runner !== "codex") return undefined;
  const pairs: unknown = JSON.parse(proof.identity.runnerEnvironment ?? "[]");
  if (!Array.isArray(pairs)) return undefined;
  for (const entry of pairs) if (Array.isArray(entry) && entry[0] === "CODEX_PUBLIC_NATIVE" && typeof entry[1] === "string" && /^sha256:[a-f0-9]{64}$/.test(entry[1])) return entry[1];
  return undefined;
}
