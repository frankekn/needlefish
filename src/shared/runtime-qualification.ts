import type { RunnerName } from "./runner.js";
import { runnerEnvironmentAttestationError, type ReportAttestation } from "./runner-attestation.js";
import { matchRuntimeIdentity, publicRuntimeIdentityFromReport, type RuntimeIdentityMatch } from "./public-runtime-identity.js";

export type RuntimeQualificationMatch = RuntimeIdentityMatch;

export type RuntimeConfigurationIdentity = { readonly runner: RunnerName; readonly model: string | null; readonly effort: string | null; readonly promptHash: string; readonly gitSha?: string | null; readonly gateClass?: "R" | "D"; readonly scorerHash?: string; readonly fixtureSetHash?: string; readonly anticheatVersion?: number } & ReportAttestation;

// Equality establishes configuration correspondence, never that a report passed its quality gate.
export function matchQualifiedConfiguration(
  actual: RuntimeConfigurationIdentity,
  qualified: RuntimeConfigurationIdentity,
): RuntimeQualificationMatch {
  if (runnerEnvironmentAttestationError(actual) || runnerEnvironmentAttestationError(qualified)) return "unknown";
  const keys = ["runner", "model", "effort", "provider", "route", "runnerVersion", "promptHash", "gitSha", "runnerEnvironment", "gateClass", "scorerHash", "fixtureSetHash", "anticheatVersion"] as const;
  if (keys.some((key) => !actual[key] || !qualified[key])) return "unknown";
  if (actual.runner === "acp" && qualified.runner === "acp") {
    const match = matchRuntimeIdentity(publicRuntimeIdentityFromReport(actual), publicRuntimeIdentityFromReport(qualified));
    if (match !== "exact") return match;
  }
  return keys.every((key) => actual[key] === qualified[key]) ? "exact" : "different";
}
