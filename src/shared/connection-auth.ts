import { ConnectionCredentialLeakError } from "./runner-failure.js";
import type { RunnerName } from "./runner.js";
import { screenPayload, screenText } from "./outbound-screen.js";

function decodeJsonEscapes(text: string): string {
  return text.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, (escape: string) => {
    const value: unknown = JSON.parse(`"${escape}"`);
    return typeof value === "string" ? value : escape;
  });
}

function containsCredential(text: string, values: readonly string[]): boolean {
  return screenText(text, values).kind === "withheld" || screenText(decodeJsonEscapes(text), values).kind === "withheld";
}

export type AuthEnvironmentReferences = Readonly<Record<string, string>>;

// This increment accepts API keys/tokens, not arbitrary environment overrides.
// GitHub orchestration credentials must never reach a review agent.
function credentialName(name: string): boolean {
  return /^(?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN)$/.test(name)
    && !/^(?:GH|GITHUB|GIT|NEEDLEFISH)_/.test(name);
}

export function parseAuthEnvironment(raw: unknown): AuthEnvironmentReferences {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Connection auth.env must map agent credential names to source environment variable names.");
  }
  const entries = Object.entries(raw);
  if (entries.length === 0) throw new Error("Connection auth.env must not be empty.");
  for (const [target, source] of entries) {
    if (!credentialName(target)) {
      throw new Error("Connection auth.env targets must be API_KEY/TOKEN or end in _API_KEY/_TOKEN; GitHub, Git and Needlefish variables are reserved.");
    }
    if (typeof source !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(source)
      || /^(?:GH|GITHUB|GIT|NEEDLEFISH|XDG|NODE|LD|DYLD)_/i.test(source)
      || /^(?:HOME|USERPROFILE|HOMEDRIVE|HOMEPATH|PATH|PATHEXT|SHELL|COMSPEC|BASH_ENV|ENV|(?:HTTP|HTTPS|ALL|NO)_PROXY)$/i.test(source)) {
      throw new Error("Connection auth.env sources must be credential environment variable names, not orchestration, process, HOME, executable or routing overrides.");
    }
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string>);
}

// Bind at selection time, not at each retry/pass. Private storage keeps values
// out of JSON.stringify/options inspection; no file, argv or global env writes.
export class AcpEnvironmentAuth {
  readonly #values: Readonly<Record<string, string>>;

  constructor(refs: AuthEnvironmentReferences, env: NodeJS.ProcessEnv = process.env) {
    const checked = parseAuthEnvironment(refs);
    this.#values = Object.freeze(Object.fromEntries(Object.entries(checked).map(([target, source]) => {
      const value = Object.hasOwn(env, source) ? env[source] : undefined;
      if (value === undefined || value === "" || value !== value.trim() || value.includes("\0")) {
        throw new Error("Selected connection credential is missing, empty, invalid or has leading/trailing whitespace. Set its auth.env source variable before retrying; no default account was used.");
      }
      return [target, value];
    })));
    Object.freeze(this);
  }

  // Shared routes must not silently disappear when legacy passthrough is cut.
  // A separate increment can model non-secret per-connection routing explicitly.
  assertCompatible(runner: RunnerName, env: NodeJS.ProcessEnv = process.env): void {
    if (runner !== "acp") throw new Error("Per-connection environment authentication currently requires the acp adapter.");
    if (env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH?.trim()) {
      throw new Error("Connection auth.env cannot be combined with NEEDLEFISH_RUNNER_ENV_PASSTHROUGH. Move credential references into auth.env; explicitly reconcile any routing settings before retrying. No settings were silently discarded.");
    }
  }

  applyTo(env: NodeJS.ProcessEnv): void {
    Object.assign(env, this.#values);
  }

  screenDiagnostic(message: string): string {
    return containsCredential(message, Object.values(this.#values))
      ? "Needlefish withheld runner diagnostic: it contained a selected connection credential."
      : message;
  }

  assertOutputSafe(output: string): void {
    const knownValues = Object.values(this.#values);
    if (containsCredential(output, knownValues)
      || screenPayload(output, knownValues).kind === "withheld"
      || output.split(/\r?\n/).some((line) => screenPayload(line, knownValues).kind === "withheld")) {
      throw new ConnectionCredentialLeakError();
    }
  }
}


export type CodexAuthRoute =
  | { readonly kind: "openai" }
  | { readonly kind: "cliproxyapi"; readonly baseUrl: string };

export function parseCodexRoute(raw: unknown): CodexAuthRoute {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || !("kind" in raw)) {
    throw new Error("Codex auth requires an explicit openai or cliproxyapi route.");
  }
  if (raw.kind === "openai" && Object.keys(raw).length === 1) return Object.freeze({ kind: "openai" });
  if (raw.kind === "cliproxyapi" && "baseUrl" in raw && typeof raw.baseUrl === "string"
    && raw.baseUrl === raw.baseUrl.trim() && !/[\\\s?#]/.test(raw.baseUrl) && !Array.from(raw.baseUrl).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) && !/^https?:\/\/[^/]*@/i.test(raw.baseUrl)
    && Object.keys(raw).every(key => key === "kind" || key === "baseUrl")) {
    let url: URL;
    try { url = new URL(raw.baseUrl); decodeURIComponent(raw.baseUrl); } catch { throw new Error("Codex proxy route requires a valid non-secret HTTP(S) baseUrl."); }
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash) {
      return Object.freeze({ kind: "cliproxyapi", baseUrl: raw.baseUrl });
    }
  }
  throw new Error("Codex route must be openai or cliproxyapi with a non-secret HTTP(S) baseUrl without userinfo, query or fragment.");
}

export function parseCodexAuthEnvironment(raw: unknown, route: CodexAuthRoute): AuthEnvironmentReferences {
  const refs = parseAuthEnvironment(raw);
  const target = route.kind === "openai" ? "CODEX_API_KEY" : "CODEX_PROXY_API_KEY";
  if (Object.keys(refs).length !== 1 || !Object.hasOwn(refs, target)) {
    throw new Error("Codex auth.env requires exactly CODEX_API_KEY for openai or CODEX_PROXY_API_KEY for cliproxyapi.");
  }
  return refs;
}

function* codexCredentialViews(text: string): Generator<string> {
  yield text;
  for (let pass = 0; pass < 2; pass++) {
    text = decodeJsonEscapes(text);
    yield text;
    text = text.replace(/(?:%[0-9a-f]{2})+/gi, bytes => Buffer.from(bytes.replaceAll("%", ""), "hex").toString("utf8"));
    yield text;
  }
}

export class CodexEnvironmentAuth {
  readonly #auth: AcpEnvironmentAuth;
  readonly #route: CodexAuthRoute;

  constructor(refs: AuthEnvironmentReferences, route: CodexAuthRoute, env: NodeJS.ProcessEnv = process.env) {
    this.#route = parseCodexRoute(route);
    const checked = parseCodexAuthEnvironment(refs, this.#route);
    if (env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH?.trim()) {
      throw new Error("Codex connection auth cannot be combined with legacy passthrough; explicitly reconcile routing before retrying.");
    }
    if (route.kind === "openai" && (env.CODEX_PROXY_BASE_URL?.trim() || env.CODEX_PROXY_API_KEY?.trim() || env.NEEDLEFISH_CODEX_PROXY_REQUIRED === "1")) {
      throw new Error("Codex direct connection conflicts with ambient proxy routing. Remove the ambient proxy tuple or select an explicit cliproxyapi connection.");
    }
    this.#auth = new AcpEnvironmentAuth(checked, env);
    const bound: NodeJS.ProcessEnv = {};
    this.#auth.applyTo(bound);
    if (Object.values(bound).some(value => value !== undefined && /\s/.test(value))) {
      throw new Error("Selected Codex connection credential contains whitespace. No default account was used.");
    }
    if (this.#route.kind === "cliproxyapi") {
      this.#auth.assertOutputSafe(this.#route.baseUrl);
      this.#auth.assertOutputSafe(decodeURIComponent(this.#route.baseUrl));
    }
    Object.freeze(this);
  }

  assertCompatible(runner: RunnerName): void {
    if (runner !== "codex") throw new Error("Codex connection authentication requires the codex adapter.");
  }

  proxyBaseUrl(): string | undefined {
    return this.#route.kind === "cliproxyapi" ? this.#route.baseUrl : undefined;
  }

  applyTo(env: NodeJS.ProcessEnv): void {
    delete env.CODEX_API_KEY;
    delete env.CODEX_PROXY_API_KEY;
    this.#auth.applyTo(env);
  }

  screenDiagnostic(message: string): string {
    for (const view of codexCredentialViews(message)) {
      const screened = this.#auth.screenDiagnostic(view);
      if (screened !== view) return screened;
    }
    return message;
  }

  assertOutputSafe(output: string): void {
    for (const view of codexCredentialViews(output)) this.#auth.assertOutputSafe(view);
  }
}
