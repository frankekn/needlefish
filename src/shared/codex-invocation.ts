import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync, type BigIntStats } from "node:fs";
import path from "node:path";
import { envFlagOn } from "./env.js";
import { RunnerFailure } from "./runner-failure.js";
import { runnerEnvironmentAttestationError } from "./runner-attestation.js";
import type { EffectiveRunnerConfig } from "./codex.js";
import { resolveRunnerBinary } from "./runner-detection.js";
import { runManagedRunnerProcess } from "./runner-process.js";
import { CODEX_PUBLIC_ENV, codexPublicEnvironment } from "./codex-public-environment.js";
import { isPublicAttestationLabel } from "./public-runtime-identity.js";

interface Capture {
  readonly environment: Readonly<NodeJS.ProcessEnv>;
  readonly ephemeralHome: boolean;
  readonly command: string;
  readonly artifact: BigIntStats | undefined;
  executable?: Buffer;
  executableDigest?: string;
  readonly authFiles: ReadonlyMap<string, Buffer>;
  readonly authRoot: string | undefined;
  readonly requiredAuth: boolean;
  readonly filesReadable: boolean;
  drifted: boolean;
  runnerVersion?: string;
}
const captures = new WeakMap<EffectiveRunnerConfig, Capture>();
const digest = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export function isNativeExecutable(bytes: Buffer): boolean {
  const magic = bytes.subarray(0, 4).toString("hex");
  return ["7f454c46", "cffaedfe", "feedfacf", "cefaedfe", "feedface", "cafebabe", "bebafeca"].includes(magic) || bytes.subarray(0, 2).toString() === "MZ";
}

export function codexInvocationEnvironment(source: Readonly<NodeJS.ProcessEnv>): Readonly<NodeJS.ProcessEnv> {
  const environment = { ...source };
  if (process.platform === "win32") {
    for (const [name, value] of Object.entries(source)) environment[name.toUpperCase()] = value;
    for (const name of (environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "").split(",").map(value => value.trim()).filter(Boolean)) environment[name] = environment[name.toUpperCase()];
  }
  return Object.freeze(environment);
}

export function publicNativeCodexDigest(artifact: string, environment: Readonly<NodeJS.ProcessEnv>): string {
  try {
    const resolved = resolveRunnerBinary("codex", codexInvocationEnvironment(environment))?.path;
    if (!resolved || realpathSync(resolved) !== realpathSync(artifact)) throw new Error("unresolved native artifact");
    const bytes = readFileSync(artifact);
    if (!isNativeExecutable(bytes)) throw new Error("opaque launcher");
    return digest(bytes);
  } catch {
    throw new Error("public native artifact must be the configured readable native Codex executable");
  }
}

export function codexAuthRoot(source: Readonly<NodeJS.ProcessEnv>): string | undefined {
  const environment = codexInvocationEnvironment(source);
  const passesCodexHome = (environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "").split(",").some(name => (process.platform === "win32" ? name.trim().toUpperCase() : name.trim()) === "CODEX_HOME");
  if (passesCodexHome && environment.CODEX_HOME) return environment.CODEX_HOME;
  const home = process.platform === "win32" ? environment.USERPROFILE || environment.HOME : environment.HOME || environment.USERPROFILE;
  return home ? path.join(home, ".codex") : undefined;
}

export function captureCodexInvocation(config: EffectiveRunnerConfig): void {
  if (config.runner !== "codex") return;
  const environment = codexInvocationEnvironment(process.env);
  const ephemeralHome = envFlagOn("NEEDLEFISH_EPHEMERAL_HOME");
  const resolved = resolveRunnerBinary("codex", environment);
  const command = resolved?.path ? path.resolve(resolved.path) : resolved?.command ?? "codex";
  let artifact: BigIntStats | undefined;
  try { if (resolved?.path) artifact = statSync(command, { bigint: true }); } catch { /* Spawn retains its existing missing-command failure. */ }
  const authRoot = codexAuthRoot(environment);
  const envAuth = Boolean(config.codexProxy || config.connectionAuth || (environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "").split(",").some(name => (process.platform === "win32" ? name.trim().toUpperCase() : name.trim()) === "CODEX_API_KEY" && environment.CODEX_API_KEY));
  const requiredAuth = !envAuth;
  const authFiles = new Map<string, Buffer>();
  let filesReadable = true;
  if (!config.connectionAuth && ephemeralHome && authRoot) {
    for (const relative of envAuth ? [] : ["auth.json", "config.toml"]) {
      const file = path.join(authRoot, relative);
      try { if (existsSync(file)) authFiles.set(relative, readFileSync(file)); }
      catch { filesReadable = false; }
    }
  }
  captures.set(config, { environment, ephemeralHome, command, artifact, authFiles, authRoot, requiredAuth, filesReadable, drifted: false });
}

export function capturedCodexEnvironment(config: EffectiveRunnerConfig): Readonly<NodeJS.ProcessEnv> | undefined {
  return captures.get(config)?.environment;
}

function sameCapturedArtifact(capture: Capture, file: string): boolean {
  const current = statSync(file, { bigint: true });
  const original = capture.artifact;
  return original !== undefined && current.dev === original.dev && current.ino === original.ino && current.size === original.size && current.mtimeNs === original.mtimeNs && current.ctimeNs === original.ctimeNs && current.mode === original.mode;
}

function assertCapturedExecutable(capture: Capture): void {
  if (capture.artifact === undefined) return;
  try { if (sameCapturedArtifact(capture, capture.command)) return; } catch { /* Missing or unreadable executable is also drift. */ }
  capture.drifted = true;
  throw new RunnerFailure("startup_failed", "captured Codex executable changed; resolve the runner again before invoking it");
}

export function prepareCapturedCodexHome(config: EffectiveRunnerConfig, tmp: string): string | undefined {
  const capture = captures.get(config);
  if (!capture) return undefined;
  assertCapturedExecutable(capture);
  if (config.connectionAuth || !capture.ephemeralHome) return undefined;
  if (!capture.filesReadable || capture.requiredAuth && !capture.authFiles.has("auth.json")) throw new Error("NEEDLEFISH_EPHEMERAL_HOME=1 but required auth source is missing or unreadable (runner codex). Refusing to fall back to the real HOME.");
  const home = path.join(tmp, "home");
  mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 });
  for (const [relative, bytes] of capture.authFiles) {
    const destination = path.join(home, ".codex", relative);
    writeFileSync(destination, bytes, { mode: 0o600 });
  }
  return home;
}

export function checkCodexInvocation(config: EffectiveRunnerConfig, actualCommand?: string, actualHome?: string): void {
  const capture = captures.get(config);
  if (!capture) return;
  try {
    const trackedNames = [...CODEX_PUBLIC_ENV, "HOME", "USERPROFILE", "CODEX_PROXY_BASE_URL", "CODEX_PROXY_API_KEY", ...(capture.environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "").split(",").map(name => name.trim()).filter(Boolean)];
    if (trackedNames.some(name => process.env[name] !== capture.environment[name])) capture.drifted = true;
    if (!sameCapturedArtifact(capture, capture.command) || actualCommand !== undefined && !sameCapturedArtifact(capture, actualCommand)) capture.drifted = true;
    for (const [relative, bytes] of capture.authFiles) {
      if (!capture.authRoot || !readFileSync(path.join(capture.authRoot, relative)).equals(bytes) || actualHome !== undefined && capture.ephemeralHome && !readFileSync(path.join(actualHome, ".codex", relative)).equals(bytes)) capture.drifted = true;
    }
    if (capture.authRoot && capture.ephemeralHome && capture.requiredAuth) {
      for (const relative of ["auth.json", "config.toml"]) {
        if (!capture.authFiles.has(relative) && existsSync(path.join(capture.authRoot, relative))) capture.drifted = true;
      }
    }
  } catch { capture.drifted = true; }
}

export function capturedCodexCommand(config: EffectiveRunnerConfig): string {
  const capture = captures.get(config);
  if (!capture) throw new Error("missing Codex invocation capture");
  assertCapturedExecutable(capture);
  checkCodexInvocation(config);
  return capture.command;
}

export async function probeCapturedCodex(config: EffectiveRunnerConfig, publicDigest: string, tmp: string, reviewDeadlineMs?: number): Promise<void> {
  if (reviewDeadlineMs !== undefined && performance.now() >= reviewDeadlineMs) return;
  const capture = captures.get(config);
  checkCodexInvocation(config);
  if (!capture || capture.drifted || config.codexProxy || config.connectionAuth) return;
  try {
    capture.executable = readFileSync(capture.command);
    checkCodexInvocation(config);
    if (capture.drifted || !isNativeExecutable(capture.executable)) return;
    capture.executableDigest = digest(capture.executable);
  } catch { capture.drifted = true; return; }
  const runnerEnvironment = codexPublicEnvironment(capture.environment, config.model ?? null, config.effectiveEffort ?? null, capture.executableDigest);
  if (runnerEnvironmentAttestationError({ runner: "codex", model: config.model ?? null, effort: config.effectiveEffort ?? null, provider: "OpenAI Codex", route: "Codex native", runnerVersion: "pending", privateEnvironment: false, runnerEnvironment })) return;
  if (!/^sha256:[a-f0-9]{64}$/.test(publicDigest)) return;
  try {
    const command = capturedCodexCommand(config);
    const timeoutMs = Math.min(config.timeoutMs, 2000, reviewDeadlineMs === undefined ? Infinity : Math.floor(reviewDeadlineMs - performance.now()));
    if (timeoutMs <= 0) return;
    const result = await runManagedRunnerProcess({ command, args: ["--version"], repoPath: tmp, timeoutMs, timeoutKillSignal: "SIGKILL", onSpawn: controller => controller.endStdin(), env: { PATH: capture.environment.PATH, HOME: tmp, USERPROFILE: tmp } });
    const version = result.stdout.trim();
    if (result.status === 0 && !result.error && /^codex-cli \d+\.\d+\.\d+(?:[-+.][A-Za-z0-9.-]+)?$/.test(version) && isPublicAttestationLabel(version, capture.environment)) capture.runnerVersion = version.slice("codex-cli ".length);
  } catch { /* Optional metadata cannot fail a successful review. */ }
  checkCodexInvocation(config);
}

export function capturedCodexIdentity(config: EffectiveRunnerConfig): { readonly provider: string; readonly route: string; readonly runnerVersion: string; readonly runnerEnvironment: string; readonly privateEnvironment: false; readonly launcherDigest: string } | undefined {
  const capture = captures.get(config);
  checkCodexInvocation(config);
  if (!capture?.executable || !isNativeExecutable(capture.executable) || capture.drifted || !capture.runnerVersion || config.codexProxy || config.connectionAuth) return undefined;
  const launcherDigest = capture.executableDigest;
  if (launcherDigest === undefined) return undefined;
  const environment = codexPublicEnvironment(capture.environment, config.model ?? null, config.effectiveEffort ?? null, launcherDigest);
  if (environment.includes('"<required>"') || environment.includes('"<redacted>"')) return undefined;
  return { provider: "OpenAI Codex", route: "Codex native", runnerVersion: capture.runnerVersion, runnerEnvironment: environment, privateEnvironment: false, launcherDigest };
}
