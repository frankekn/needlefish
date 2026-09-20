import type { RunnerName } from "./runner.js";

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
      || /^(?:GH|GITHUB|GIT)_/i.test(source)) {
      throw new Error("Connection auth.env sources must be environment variable names, not credentials or GitHub/Git orchestration variables.");
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
      if (value === undefined || value.trim() === "" || value.includes("\0")) {
        throw new Error("Selected connection credential is missing, empty or invalid. Set its auth.env source variable before retrying; no default account was used.");
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
}
