export const RUNNERS = ["codex", "claude", "opencode", "openai", "grok", "pi", "acp"] as const;

export type RunnerName = (typeof RUNNERS)[number];

export interface RunnerDefinition {
  readonly modelEnv?: string;
  readonly envAllowlist: readonly string[];
  readonly authFiles: readonly string[];
  readonly envConfigFiles: readonly string[];
}

export const RUNNER_DEFINITIONS: Readonly<Record<RunnerName, RunnerDefinition>> = {
  codex: {
    modelEnv: "CODEX_MODEL",
    envAllowlist: ["CODEX_BIN", "CODEX_MODEL", "CODEX_PROXY_API_KEY", "CODEX_REASONING_EFFORT", "CODEX_RETRY_MS", "CODEX_TIMEOUT_MS"],
    authFiles: [".codex/auth.json", ".codex/config.toml"],
    envConfigFiles: [],
  },
  claude: {
    modelEnv: "CLAUDE_MODEL",
    envAllowlist: ["CLAUDE_BIN", "CLAUDE_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    authFiles: [],
    envConfigFiles: [],
  },
  opencode: {
    modelEnv: "OPENCODE_MODEL",
    envAllowlist: ["OPENCODE_BIN", "OPENCODE_MODEL", "OPENAI_API_KEY"],
    authFiles: [".config/opencode/opencode.json", ".local/share/opencode/auth.json"],
    envConfigFiles: [".config/opencode/opencode.json"],
  },
  openai: {
    modelEnv: "OPENAI_MODEL",
    envAllowlist: [],
    authFiles: [],
    envConfigFiles: [],
  },
  grok: {
    modelEnv: "GROK_MODEL",
    envAllowlist: ["GROK_BIN", "GROK_MODEL"],
    authFiles: [".grok/auth.json", ".grok/config.toml"],
    envConfigFiles: [".grok/config.toml"],
  },
  pi: {
    modelEnv: "PI_MODEL",
    envAllowlist: ["PI_BIN", "PI_MODEL", "PI_PROVIDER", "PI_AUTH_MODE"],
    authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
    envConfigFiles: [".pi/agent/models.json"],
  },
  acp: {
    envAllowlist: ["NEEDLEFISH_ACP_BIN"],
    authFiles: [],
    envConfigFiles: [],
  },
};

export interface RunnerOptions {
  readonly runner?: RunnerName;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly reasoningEffort?: string;
}

export interface RunStat {
  readonly label: string;
  readonly runner: RunnerName;
  readonly model?: string;
  readonly durationMs: number;
  readonly attempts: number;
  readonly ok: boolean;
}

const RUNNER_NAMES = new Set<string>(RUNNERS);

export function isRunnerName(value: string): value is RunnerName {
  return RUNNER_NAMES.has(value);
}

export function parseRunnerName(value: string, label: string): RunnerName {
  if (isRunnerName(value)) return value;
  throw new Error(`${label} must be one of: ${RUNNERS.join(", ")}`);
}

export function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} requires a positive integer`);
  }
  return parsed;
}
