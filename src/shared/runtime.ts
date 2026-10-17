import path from "node:path";
import { mkdirSync, readFileSync } from "node:fs";
import { capturedCodexIdentity, probeCapturedCodex } from "./codex-invocation.js";
import { nativeDigestFromProof, parseQualificationProof, parseRuntimeQualification, type QualificationProof, type RuntimeQualification } from "./qualification-proof.js";
import { matchQualifiedConfiguration } from "./runtime-qualification.js";
import { promptHash } from "./prompt-hash.js";
import type { EffectiveRunnerConfig } from "./codex.js";
import { runtimeLabel, type RuntimeValue } from "./runtime-value.js";
export { runtimeLabel, type RuntimeValue } from "./runtime-value.js";
import { isRunnerName, type RunnerName } from "./runner.js";

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
  readonly qualification: RuntimeQualification;
}

function readRelease(): unknown {
  try { return JSON.parse(readFileSync(new URL("../../release.json", import.meta.url), "utf8")); }
  catch { return undefined; }
}

function packageIdentity(release: unknown = readRelease()): Pick<ReviewRuntime, "coreVersion" | "sourceSha"> {
  let coreVersion: RuntimeValue = runtimeLabel(undefined);
  try {
    const pkg: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    if (isRecord(pkg) && typeof pkg.version === "string") coreVersion = runtimeLabel(pkg.version);
  } catch { /* Optional identity must not reject an otherwise valid review. */ }
  const sourceSha = sourceShaFromRelease(release);
  return { coreVersion, sourceSha };
}

export function sourceShaFromRelease(release: unknown): RuntimeValue {
  if (!isRecord(release)) return runtimeLabel(undefined);
  const sha = typeof release.sha === "string" && /^[a-f0-9]{40}$/.test(release.sha)
    ? release.sha : release.base_sha;
  return typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)
    ? runtimeLabel(sha, "operator_attested") : runtimeLabel(undefined);
}

interface RuntimeContext {
  readonly packageIdentity: Pick<ReviewRuntime, "coreVersion" | "sourceSha">;
  readonly proof: QualificationProof | undefined;
  readonly exactSource: string | undefined;
  readonly invalidProof: boolean;
}
const contexts = new WeakMap<EffectiveRunnerConfig, RuntimeContext>();

export function prepareReviewRuntime(config: EffectiveRunnerConfig): void {
  const release = readRelease();
  const identity = packageIdentity(release ?? null);
  let proof: QualificationProof | undefined;
  let exactSource: string | undefined;
  let invalidProof = false;
  try {
    if (isRecord(release)) {
      if (typeof release.sha === "string" && /^[a-f0-9]{40}$/.test(release.sha) && release.patch_sha256 === undefined && release.base_sha === undefined) exactSource = release.sha;
      if (release.qualification !== undefined) {
        try { proof = parseQualificationProof(release.qualification); }
        catch { invalidProof = true; }
      }
    }
  } catch { /* A missing release keeps local reviews usable and unqualified. */ }
  contexts.set(config, { packageIdentity: identity, proof, exactSource, invalidProof });
}

export async function completeReviewRuntime(config: EffectiveRunnerConfig, tmp: string): Promise<void> {
  const context = contexts.get(config);
  const proof = context?.proof;
  const nativeDigest = proof && nativeDigestFromProof(proof);
  if (nativeDigest && config.runner === "codex" && context?.exactSource !== undefined && proof?.identity.gitSha === context.exactSource) {
    const probeDirectory = path.join(tmp, "runtime-probe");
    try { mkdirSync(probeDirectory, { recursive: true, mode: 0o700 }); await probeCapturedCodex(config, nativeDigest, probeDirectory); }
    catch { /* Optional identity probes never reject a review. */ }
  }
}

export function reviewRuntime(config: EffectiveRunnerConfig, reviewBudgetMs: number | null): ReviewRuntime {
  let promptIdentity: RuntimeValue = runtimeLabel(undefined);
  try {
    promptIdentity = runtimeLabel(promptHash());
  } catch { /* Hash metadata is optional; prompt loading retains its own failures. */ }
  const context = contexts.get(config);
  const proof = context?.proof;
  const observed = proof ? capturedCodexIdentity(config) : undefined;
  const packageValues = context?.packageIdentity ?? packageIdentity();
  const model = runtimeLabel(config.runner === "acp" ? undefined : config.model, "known", "model");
  const effort = runtimeLabel(config.effectiveEffort);
  const runnerVersion = runtimeLabel(observed?.runnerVersion);
  const launcherDigest = runtimeLabel(observed && proof && observed.launcherDigest === nativeDigestFromProof(proof) ? observed.launcherDigest : undefined);
  let qualification: RuntimeQualification = { matchStatus: "unqualified" };
  if (context?.invalidProof) qualification = { matchStatus: "unqualified", reason: "report_not_admitted" };
  else if (proof) {
    if (!context?.exactSource || proof.identity.gitSha !== context.exactSource || !observed || promptIdentity.status === "unknown") qualification = { matchStatus: "unqualified", reason: "unknown_identity" };
    else {
      const match = matchQualifiedConfiguration({
        runner: config.runner, model: config.model ?? null, effort: config.effectiveEffort ?? null,
        promptHash: promptIdentity.value, gitSha: context.exactSource,
        gateClass: proof.identity.gateClass, scorerHash: proof.identity.scorerHash,
        fixtureSetHash: proof.identity.fixtureSetHash, anticheatVersion: proof.identity.anticheatVersion,
        ...observed,
      }, proof.identity);
      const complete = [packageValues.coreVersion, packageValues.sourceSha, model, effort, runnerVersion, launcherDigest].every(value => value.status !== "unknown");
      if (match === "exact" && complete) qualification = { matchStatus: "tested", policyVersion: proof.policyVersion, reportId: proof.reportId };
      else qualification = { matchStatus: "unqualified", reason: match === "different" ? "different_configuration" : "unknown_identity" };
    }
  }
  return Object.freeze({
    ...packageValues,
    runner: config.runner,
    runnerVersion,
    launcherDigest,
    model,
    effort,
    promptHash: promptIdentity,
    callTimeoutMs: config.timeoutMs,
    reviewBudgetMs,
    qualification: Object.freeze(qualification),
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
  const qualification = parseRuntimeQualification(value.qualification);
  const parsed: ReviewRuntime = {
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
    qualification,
  };
  if (qualification.matchStatus === "tested" && (
    [parsed.coreVersion, parsed.sourceSha, parsed.runnerVersion, parsed.launcherDigest, parsed.model, parsed.effort, parsed.promptHash].some(identity => identity.status === "unknown") ||
    parsed.sourceSha.status === "unknown" || !/^[a-f0-9]{40}$/.test(parsed.sourceSha.value) ||
    parsed.launcherDigest.status === "unknown" || !/^sha256:[a-f0-9]{64}$/.test(parsed.launcherDigest.value)
  )) throw new Error("tested runtime qualification requires complete public identities");
  return parsed;
}
