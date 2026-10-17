import { readFileSync } from "node:fs";
import { promptHash } from "./prompt-hash.js";
import type { EffectiveRunnerConfig } from "./codex.js";
import { credentialValuesFromEnv, screenText } from "./outbound-screen.js";
import { isRunnerName, type RunnerName } from "./runner.js";

export type RuntimeValue =
  | { readonly status: "unknown" }
  | { readonly status: "known" | "operator_attested"; readonly value: string };

export interface ReviewRuntime {
  readonly coreVersion: RuntimeValue;
  readonly sourceSha: RuntimeValue;
  readonly runner: RunnerName;
  readonly runnerVersion: RuntimeValue;
  readonly launcherDigest: RuntimeValue;
  // The selector passed to the runner, not a provider's resolved model identity.
  readonly model: RuntimeValue;
  readonly effort: RuntimeValue;
  readonly promptHash: RuntimeValue;
  readonly callTimeoutMs: number;
  readonly reviewBudgetMs: number | null;
  readonly qualification: { readonly matchStatus: "unqualified" };
}

export function runtimeLabel(value: string | undefined, status: "known" | "operator_attested" = "known", kind: "identity" | "model" = "identity"): RuntimeValue {
  const pattern = kind === "model" ? /^[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,159}$/ : /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,159}$/;
  if (!value || !pattern.test(value) ||
      value.includes("://") || /(?:^|\/)(?:Users|home)\//.test(value) ||
      screenText(value, credentialValuesFromEnv(process.env)).kind !== "clean") return Object.freeze({ status: "unknown" });
  return Object.freeze({ status, value });
}

function packageIdentity(): Pick<ReviewRuntime, "coreVersion" | "sourceSha"> {
  let coreVersion: RuntimeValue = runtimeLabel(undefined);
  let sourceSha: RuntimeValue = runtimeLabel(undefined);
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    if (isRecord(pkg) && typeof pkg.version === "string") coreVersion = runtimeLabel(pkg.version);
  } catch { /* Optional identity must not reject an otherwise valid review. */ }
  try {
    const release: unknown = JSON.parse(readFileSync(new URL("../../release.json", import.meta.url), "utf8"));
    sourceSha = sourceShaFromRelease(release);
  } catch { /* Source installs may have no release manifest. */ }
  return { coreVersion, sourceSha };
}

export function sourceShaFromRelease(release: unknown): RuntimeValue {
  if (!isRecord(release)) return runtimeLabel(undefined);
  const sha = typeof release.sha === "string" && /^[a-f0-9]{40}$/.test(release.sha)
    ? release.sha : release.base_sha;
  return typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)
    ? runtimeLabel(sha, "operator_attested") : runtimeLabel(undefined);
}

export function reviewRuntime(config: EffectiveRunnerConfig, reviewBudgetMs: number | null): ReviewRuntime {
  let promptIdentity: RuntimeValue = runtimeLabel(undefined);
  try {
    promptIdentity = runtimeLabel(promptHash());
  } catch { /* Hash metadata is optional; prompt loading retains its own failures. */ }
  return Object.freeze({
    ...packageIdentity(),
    runner: config.runner,
    runnerVersion: runtimeLabel(undefined),
    launcherDigest: runtimeLabel(undefined),
    model: runtimeLabel(config.runner === "acp" ? undefined : config.model, "known", "model"),
    effort: runtimeLabel(config.effectiveEffort),
    promptHash: promptIdentity,
    callTimeoutMs: config.timeoutMs,
    reviewBudgetMs,
    qualification: Object.freeze({ matchStatus: "unqualified" }),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRuntimeValue(value: unknown, kind: "identity" | "model" = "identity"): RuntimeValue {
  if (!isRecord(value)) throw new Error("identity is not an object");
  if (value.status === "unknown") return { status: "unknown" };
  if ((value.status === "known" || value.status === "operator_attested") && typeof value.value === "string") {
    return runtimeLabel(value.value, value.status, kind);
  }
  throw new Error("invalid identity provenance");
}

export function parseReviewRuntime(value: unknown): ReviewRuntime {
  if (!isRecord(value)) throw new Error("runtime is not an object");
  if (typeof value.runner !== "string" || !isRunnerName(value.runner)) throw new Error("invalid runtime runner");
  if (typeof value.callTimeoutMs !== "number" || !Number.isSafeInteger(value.callTimeoutMs) || value.callTimeoutMs <= 0) throw new Error("invalid call timeout");
  if (value.reviewBudgetMs !== null && (typeof value.reviewBudgetMs !== "number" || !Number.isSafeInteger(value.reviewBudgetMs) || value.reviewBudgetMs <= 0)) throw new Error("invalid review budget");
  if (!isRecord(value.qualification) || value.qualification.matchStatus !== "unqualified") throw new Error("invalid runtime qualification");
  return {
    coreVersion: parseRuntimeValue(value.coreVersion),
    sourceSha: parseRuntimeValue(value.sourceSha),
    runner: value.runner,
    runnerVersion: parseRuntimeValue(value.runnerVersion),
    launcherDigest: parseRuntimeValue(value.launcherDigest),
    model: parseRuntimeValue(value.model, "model"),
    effort: parseRuntimeValue(value.effort),
    promptHash: parseRuntimeValue(value.promptHash),
    callTimeoutMs: value.callTimeoutMs,
    reviewBudgetMs: value.reviewBudgetMs,
    qualification: { matchStatus: "unqualified" },
  };
}
