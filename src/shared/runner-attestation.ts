import { PI_DEFAULT_MODEL, type RunnerName } from "./runner.js";
import { isPublicAttestationLabel, publicRuntimeIdentityFromReport } from "./public-runtime-identity.js";
export interface ReportAttestation {
  readonly provider?: string;
  readonly route?: string;
  readonly runnerVersion?: string;
  readonly runnerEnvironment?: string;
  readonly privateEnvironment?: boolean;
  readonly publicEnvironmentAttestation?: unknown;
}

export function comparisonEnvironmentError(report: ReportAttestation & { readonly runner?: RunnerName }): string | null {
  if ([report.provider, report.route, report.runnerVersion].some((value) => typeof value === "string" && !isPublicAttestationLabel(value, process.env))) return "private runner environment identity";
  if (report.privateEnvironment === true) return "private runner environment identity";
  if (report.runnerEnvironment === undefined) return report.runner === "acp" ? "unknown runner environment identity" : null;
  let pairs: unknown;
  try { pairs = JSON.parse(report.runnerEnvironment); } catch { return "unknown runner environment identity"; }
  if (!Array.isArray(pairs) || pairs.some((entry) => !Array.isArray(entry) || entry.length !== 2 || entry.some((value) => typeof value !== "string"))) return "unknown runner environment identity";
  if (pairs.some((entry) => entry[1] === "<required>" || entry[1] === "<redacted>")) return "private runner environment identity";
  if (report.runner === "acp" || pairs.some((entry) => entry[0] === "ACP_PUBLIC_RUNTIME")) {
    try {
      const identity = publicRuntimeIdentityFromReport(report);
      if ([identity.launcherDigest, identity.harnessVersion, identity.authSource].some((value) => value.status === "unknown")) return "unknown runner environment identity";
    } catch { return "unknown runner environment identity"; }
  }
  return null;
}

const RUNNER_MODEL_ENV: Partial<Record<RunnerName, string>> = {
  codex: "CODEX_MODEL",
  claude: "CLAUDE_MODEL",
  opencode: "OPENCODE_MODEL",
  openai: "OPENAI_MODEL",
  grok: "GROK_MODEL",
  pi: "PI_MODEL",
};

export function hasResolvedModelIdentity(
  report: { readonly runner: RunnerName; readonly model: string | null; readonly effort: string | null } &
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
    (report.runner === "pi" ? PI_DEFAULT_MODEL : undefined);
  const effort =
    report.effort ??
    (report.runner === "codex"
      ? environment.get("CODEX_REASONING_EFFORT")
      : report.runner === "pi"
        ? "medium"
        : undefined);
  return [model, effort].every((value) =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    !/^(unknown|private|unspecified|unresolved)$/i.test(value.trim()),
  );
}

export function runnerEnvironmentAttestationError(
  report: { readonly runner: RunnerName; readonly model: string | null; readonly effort: string | null } & ReportAttestation,
): string | null {
  if (
    ![report.provider, report.route, report.runnerVersion].every(
      (value) => typeof value === "string" && value.trim().length > 0,
    )
  ) {
    return "public lanes require attested provider, route, and runner version";
  }
  if ([report.provider, report.route, report.runnerVersion].some((value) => typeof value === "string" && !isPublicAttestationLabel(value, process.env))) return "public lanes require public provider, route, and runner version labels";
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
  const pairs = entries.filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2 && entry.every(value => typeof value === "string"));
  if (new Set(pairs.map(([key]) => key)).size !== pairs.length) {
    return "public runner-environment attestation cannot contain duplicate keys";
  }
  const environment = new Map(pairs);
  if ([...environment.values()].some((value) => value === "<required>" || value === "<redacted>")) {
    return "public lanes cannot contain redacted runner-environment values";
  }
  if (
    environment.get("NEEDLEFISH_EPHEMERAL_HOME") !== "1" ||
    environment.get("NEEDLEFISH_EVAL_TRACE") !== "1"
  ) {
    return "public lanes require guarded runner-environment attestation";
  }
  if (report.runner === "codex" && environment.has("CODEX_HOME")) return "public native Codex lanes require the standard captured home";
  if (report.runner === "acp") {
    try {
      const identity = publicRuntimeIdentityFromReport(report);
      if ([identity.launcherDigest, identity.harnessVersion, identity.authSource].some((value) => value.status === "unknown")) return "public ACP lanes require complete public launcher, harness and auth-source identities";
    } catch {
      return "public ACP lanes require a valid public runtime identity";
    }
  }
  if (!hasResolvedModelIdentity(report)) {
    return "public lanes require a resolved model and effort identity";
  }
  return null;
}
