import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { runtimeLabel, type RuntimeValue } from "../../src/shared/runtime";
import { executableNames } from "../../src/shared/runner-detection";
import { screenText } from "../../src/shared/outbound-screen";

export interface PublicRuntimeIdentity {
  readonly version: 1;
  readonly launcherDigest: RuntimeValue;
  readonly harnessVersion: RuntimeValue;
  readonly authSource: RuntimeValue;
}

export function isPublicAttestationLabel(value: string, environment: Readonly<Record<string, string | undefined>>): boolean {
  const declaredNames = new Set([environment.NEEDLEFISH_ACP_AUTH_ENV_VARS ?? "", environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? ""].flatMap((names) => names.split(",")).map((name) => name.trim().toLowerCase()).filter(Boolean));
  const credentials = [
    ...Object.entries(environment).flatMap(([name, secret]) => secret && (declaredNames.has(name.toLowerCase()) || /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i.test(name) && !/(_ENV_VARS|_FILES|_PASSTHROUGH)$/i.test(name)) ? [secret, secret.trim()].filter(Boolean) : []),
    ...(environment.NEEDLEFISH_ACP_AUTH_FILES ?? "").split(",").map((file) => file.trim()).filter(Boolean),
  ];
  return !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) && !/^~[/\\]/.test(value) && !/[:][/][/]|[?=&]/.test(value) && screenText(value, credentials).kind === "clean";
}

function publicVersion(value: string | undefined, status: "known" | "operator_attested", environment: NodeJS.ProcessEnv = process.env): RuntimeValue {
  return value && /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,159}$/.test(value) && isPublicAttestationLabel(value, environment)
    ? Object.freeze({ status, value }) : runtimeLabel(undefined);
}

export function publicLauncherCandidates(environment: Readonly<Record<string, string | undefined>>, platform: NodeJS.Platform = process.platform): string[] {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const command = environment.NEEDLEFISH_ACP_BIN?.trim();
  if (!command) return [];
  if (!pathApi.isAbsolute(command) && (command.includes(pathApi.sep) || (environment.PATH ?? "").split(pathApi.delimiter).some((dir) => !pathApi.isAbsolute(dir)))) throw new Error("public launcher resolution depends on the target working directory");
  return pathApi.isAbsolute(command) || command.includes(pathApi.sep) ? [command]
    : (environment.PATH ?? "").split(pathApi.delimiter).flatMap((dir) => executableNames(command, platform, environment.PATHEXT).map((name) => pathApi.join(dir, name)));
}

export function acpRuntimeIdentity(
  publicArtifact: string | null,
  environment: Readonly<Record<string, string | undefined>>,
  runnerVersion: string | null,
): PublicRuntimeIdentity {
  let launcherDigest: RuntimeValue = runtimeLabel(undefined);
  if (publicArtifact !== null) {
    try {
      const executable = publicLauncherCandidates(environment).find((file) => {
        try { accessSync(file, constants.X_OK); return statSync(file).isFile(); } catch { return false; }
      });
      if (!executable || realpathSync(executable) !== realpathSync(publicArtifact)) {
        throw new Error("public launcher artifact must be the configured ACP executable");
      }
      accessSync(executable, constants.X_OK);
      if (!statSync(executable).isFile()) throw new Error("public launcher artifact is not an executable file");
      launcherDigest = runtimeLabel(`sha256:${createHash("sha256").update(readFileSync(publicArtifact)).digest("hex")}`);
    } catch {
      throw new Error("public launcher artifact must be the configured ACP executable and readable");
    }
  }
  const authEnvironment = Boolean(environment.NEEDLEFISH_ACP_AUTH_ENV_VARS?.trim());
  const authFiles = Boolean(environment.NEEDLEFISH_ACP_AUTH_FILES?.trim());
  return Object.freeze({
    version: 1,
    launcherDigest,
    harnessVersion: publicVersion(runnerVersion ?? undefined, "operator_attested", environment),
    authSource: runtimeLabel(authEnvironment && authFiles ? "environment-and-files" : authEnvironment ? "environment" : authFiles ? "files" : undefined, "operator_attested"),
  });
}

export type RuntimeIdentityMatch = "exact" | "different" | "unknown";

export function matchRuntimeIdentity(actual: PublicRuntimeIdentity, expected: PublicRuntimeIdentity): RuntimeIdentityMatch {
  const keys = ["launcherDigest", "harnessVersion", "authSource"] as const;
  if (keys.some((key) => actual[key].status === "unknown" || expected[key].status === "unknown")) return "unknown";
  return keys.every((key) => {
    const left = actual[key];
    const right = expected[key];
    return left.status !== "unknown" && right.status !== "unknown" && left.status === right.status && left.value === right.value;
  }) ? "exact" : "different";
}

export function parsePublicRuntimeIdentity(raw: unknown): PublicRuntimeIdentity {
  if (typeof raw !== "object" || raw === null || !("version" in raw) || raw.version !== 1) throw new Error("invalid public runtime identity version");
  const record = raw;
  function field(key: "launcherDigest" | "harnessVersion" | "authSource"): RuntimeValue {
    const value: unknown = key === "launcherDigest" ? ("launcherDigest" in record ? record.launcherDigest : undefined)
      : key === "harnessVersion" ? ("harnessVersion" in record ? record.harnessVersion : undefined)
      : ("authSource" in record ? record.authSource : undefined);
    if (typeof value !== "object" || value === null || !("status" in value)) throw new Error("invalid public runtime identity field");
    if (value.status === "unknown") return runtimeLabel(undefined);
    if ((value.status !== "known" && value.status !== "operator_attested") || !("value" in value) || typeof value.value !== "string") throw new Error("invalid public runtime identity provenance");
    const parsed: RuntimeValue = key === "harnessVersion" ? publicVersion(value.value, value.status) : runtimeLabel(value.value, value.status);
    if (key === "launcherDigest" && (parsed.status === "unknown" || !/^sha256:[a-f0-9]{64}$/.test(parsed.value))) throw new Error("invalid public launcher digest");
    if (key === "authSource" && (parsed.status === "unknown" || !["environment", "files", "environment-and-files"].includes(parsed.value))) throw new Error("invalid public auth source");
    return parsed;
  }
  return Object.freeze({ version: 1, launcherDigest: field("launcherDigest"), harnessVersion: field("harnessVersion"), authSource: field("authSource") });
}

export function publicRuntimeIdentityFromReport(report: { readonly runnerEnvironment?: string; readonly publicEnvironmentAttestation?: unknown }): PublicRuntimeIdentity {
  const pairs: unknown = JSON.parse(report.runnerEnvironment ?? "[]");
  if (!Array.isArray(pairs)) throw new Error("invalid runner environment");
  const environment = new Map<string, string>(pairs.filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2 && entry.every((value) => typeof value === "string")));
  const current = environment.get("ACP_PUBLIC_RUNTIME");
  if (current !== undefined) return parsePublicRuntimeIdentity(JSON.parse(current));
  const attestation = report.publicEnvironmentAttestation;
  if (typeof attestation !== "object" || attestation === null || !("kind" in attestation) || attestation.kind !== "operator-attested-publication-metadata") throw new Error("missing public runtime identity");
  if (!("recordingBridgeSha256" in attestation) || typeof attestation.recordingBridgeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(attestation.recordingBridgeSha256) || environment.get("NEEDLEFISH_ACP_BIN") !== `sha256:${attestation.recordingBridgeSha256}`) throw new Error("public launcher digest does not match environment");
  if (!("harness" in attestation) || typeof attestation.harness !== "string") throw new Error("missing public harness version");
  if (!("credentialBinding" in attestation) || typeof attestation.credentialBinding !== "object" || attestation.credentialBinding === null || !("required" in attestation.credentialBinding) || attestation.credentialBinding.required !== true || !("variable" in attestation.credentialBinding) || typeof attestation.credentialBinding.variable !== "string" || !environment.get("NEEDLEFISH_ACP_AUTH_ENV_VARS")?.split(",").includes(attestation.credentialBinding.variable)) throw new Error("missing public auth-source binding");
  return parsePublicRuntimeIdentity({ version: 1,
    launcherDigest: { status: "operator_attested", value: `sha256:${attestation.recordingBridgeSha256}` },
    harnessVersion: { status: "operator_attested", value: attestation.harness },
    authSource: { status: "operator_attested", value: "environment" },
  });
}
