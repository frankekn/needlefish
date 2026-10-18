import { createHash } from "node:crypto";
import path from "node:path";
import { isPublicAttestationLabel } from "./public-runtime-identity.js";

export const CODEX_PUBLIC_ENV = [
  "PATH", "NEEDLEFISH_EPHEMERAL_HOME", "NEEDLEFISH_DEEP_CONCURRENCY", "NEEDLEFISH_EVAL_TRACE",
  "NEEDLEFISH_LARGE_FILE_COUNT", "NEEDLEFISH_LARGE_PATCH_CHARS", "NEEDLEFISH_MODEL", "NEEDLEFISH_NO_FAST_PATH",
  "NEEDLEFISH_NO_RETRY", "NEEDLEFISH_RETRY_MS", "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", "NEEDLEFISH_TIMEOUT_MS",
  "CODEX_BIN", "CODEX_MODEL", "NEEDLEFISH_CODEX_PROXY_REQUIRED", "CODEX_REASONING_EFFORT", "CODEX_RETRY_MS",
  "CODEX_SERVICE_TIER", "CODEX_TIMEOUT_MS",
] as const;
const PRIVATE_ENV = ["CODEX_HOME", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "CODEX_PROXY_BASE_URL", "CODEX_PROXY_API_KEY"];

// The eval writer and actual invocation use the same public projection, including every guard.
export function codexPublicEnvironment(environment: Readonly<NodeJS.ProcessEnv>, model: string | null, effort: string | null, publicNativeDigest: string): string {
  const names = new Set<string>([...CODEX_PUBLIC_ENV, ...PRIVATE_ENV, ...(environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "").split(",").map(name => name.trim()).filter(Boolean)]);
  const passthrough = (environment.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "").split(",").map(name => process.platform === "win32" ? name.trim().toUpperCase() : name.trim());
  const values: [string, string][] = [];
  for (const name of names) {
    if (name === "CODEX_HOME" && !passthrough.includes(name)) continue;
    const value = environment[name];
    if (value === undefined || model !== null && (name === "NEEDLEFISH_MODEL" || name === "CODEX_MODEL") || effort !== null && name === "CODEX_REASONING_EFFORT") continue;
    let projected = "<required>";
    if (CODEX_PUBLIC_ENV.some(key => key === name)) {
      projected = name === "PATH" ? value.split(path.delimiter).every(directory => path.isAbsolute(directory)) ? `sha256:${createHash("sha256").update(value).digest("hex").slice(0, 16)}` : "<required>" : value;
      if (name === "CODEX_BIN") projected = publicNativeDigest;
      else if (name !== "PATH" && !isPublicAttestationLabel(value, environment)) projected = "<required>";
    }
    values.push([name, projected]);
  }
  values.push(["CODEX_PUBLIC_NATIVE", publicNativeDigest]);
  return JSON.stringify(values.sort(([a], [b]) => a.localeCompare(b)));
}
