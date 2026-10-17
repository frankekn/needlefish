import type { Report } from "./types";
import { runnerEnvironmentAttestationError, type ReportAttestation } from "./report-integrity";
import { matchRuntimeIdentity, publicRuntimeIdentityFromReport, type RuntimeIdentityMatch } from "./runtime-identity";

export type RuntimeQualificationMatch = RuntimeIdentityMatch;

export type RuntimeConfigurationIdentity = Pick<Report, "runner" | "model" | "effort" | "promptHash" | "gitSha" | "gateClass" | "scorerHash" | "fixtureSetHash" | "anticheatVersion"> & ReportAttestation;

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
