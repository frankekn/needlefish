import { scorerHash } from "./scorer-hash";
import type { Report } from "./types";

export interface ReportAttestation {
  readonly provider?: string;
  readonly route?: string;
  readonly runnerVersion?: string;
  readonly runnerEnvironment?: string;
  readonly privateEnvironment?: boolean;
}

const RUNNER_MODEL_ENV: Partial<Record<Report["runner"], string>> = {
  codex: "CODEX_MODEL",
  claude: "CLAUDE_MODEL",
  opencode: "OPENCODE_MODEL",
  openai: "OPENAI_MODEL",
  grok: "GROK_MODEL",
  pi: "PI_MODEL",
};

export function hasResolvedModelIdentity(
  report: Pick<Report, "runner" | "model" | "effort"> &
    Pick<ReportAttestation, "runnerEnvironment">,
): boolean {
  let pairs: unknown;
  try {
    pairs = JSON.parse(report.runnerEnvironment ?? "");
  } catch {
    return false;
  }
  if (!Array.isArray(pairs)) return false;
  const environment = new Map(
    pairs.filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry.every((value) => typeof value === "string"),
    ),
  );
  const model =
    report.model ??
    environment.get("NEEDLEFISH_MODEL") ??
    environment.get(RUNNER_MODEL_ENV[report.runner] ?? "") ??
    (report.runner === "pi" ? "gpt-5.6-sol" : undefined);
  const effort =
    report.effort ??
    (report.runner === "codex"
      ? environment.get("CODEX_REASONING_EFFORT")
      : report.runner === "pi"
        ? "medium"
        : undefined);
  return (
    typeof model === "string" &&
    model.trim().length > 0 &&
    typeof effort === "string" &&
    effort.trim().length > 0
  );
}

// Reports are read from unvalidated JSON. The aggregate is trustworthy only
// when it exactly accounts for every per-draw detection.
export function hasCurrentScorer(report: Report): boolean {
  return report.scorerHash === scorerHash();
}

export function runnerEnvironmentAttestationError(
  report: Report & ReportAttestation,
): string | null {
  if (
    ![report.provider, report.route, report.runnerVersion].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    return "public lanes require attested provider, route, and runner version";
  }
  if (report.privateEnvironment !== false || typeof report.runnerEnvironment !== "string") {
    return "public lanes require a public runner-environment attestation";
  }
  let entries: unknown;
  try {
    entries = JSON.parse(report.runnerEnvironment);
  } catch {
    return "runner-environment attestation must be valid JSON";
  }
  if (
    !Array.isArray(entries) ||
    entries.some(
      (entry) =>
        !Array.isArray(entry) ||
        entry.length !== 2 ||
        entry.some((value) => typeof value !== "string"),
    )
  ) {
    return "runner-environment attestation must contain string pairs";
  }
  const pairs = entries as [string, string][];
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) {
    return "public runner-environment attestation cannot contain duplicate keys";
  }
  const environment = new Map(pairs);
  if ([...environment.values()].includes("<required>")) {
    return "public lanes cannot contain redacted runner-environment values";
  }
  if (
    environment.get("NEEDLEFISH_EPHEMERAL_HOME") !== "1" ||
    environment.get("NEEDLEFISH_EVAL_TRACE") !== "1"
  ) {
    return "public lanes require guarded runner-environment attestation";
  }
  if (!hasResolvedModelIdentity(report)) {
    return "public lanes require a resolved model and effort identity";
  }
  return null;
}

export function hasConsistentCheatDetection(report: Report): boolean {
  const count = report.aggregates?.cheatDetectedCount as number | undefined;
  const exposureCount = report.aggregates?.baitExposureCount as
    | number
    | undefined;
  const criticPrunedRecallCount = report.aggregates?.criticPrunedRecallCount as
    | number
    | undefined;
  const results: unknown = report.results;
  if (!Array.isArray(results)) return false;
  const detections: unknown[] = [];
  const exposures: unknown[] = [];
  let expectedCriticPrunedRecallCount = 0;
  for (const result of results) {
    if (typeof result !== "object" || result === null) return false;
    const score = (result as { score?: unknown }).score;
    if (typeof score !== "object" || score === null) return false;
    detections.push((score as { cheatDetected?: unknown }).cheatDetected);
    exposures.push((score as { baitExposed?: unknown }).baitExposed);
    const draw = result as {
      matchEvidence?: readonly { findingIndex?: unknown }[];
      candidateMatchEvidence?: readonly { findingIndex?: unknown }[];
    };
    if (Array.isArray(draw.matchEvidence)) {
      expectedCriticPrunedRecallCount += draw.matchEvidence.filter(
        (evidence, index) =>
          evidence.findingIndex === null &&
          draw.candidateMatchEvidence?.[index]?.findingIndex !== null &&
          draw.candidateMatchEvidence?.[index]?.findingIndex !== undefined,
      ).length;
    }
  }
  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    typeof exposureCount === "number" &&
    Number.isInteger(exposureCount) &&
    exposureCount >= 0 &&
    typeof criticPrunedRecallCount === "number" &&
    Number.isInteger(criticPrunedRecallCount) &&
    criticPrunedRecallCount >= 0 &&
    detections.every((detected) => typeof detected === "boolean") &&
    exposures.every((exposed) => typeof exposed === "boolean") &&
    count === detections.filter((detected) => detected).length &&
    exposureCount === exposures.filter((exposed) => exposed).length &&
    criticPrunedRecallCount === expectedCriticPrunedRecallCount
  );
}
