/** Static runner metadata; execution and credential-selection policy stay in the adapters. */
export interface RunnerDefinition {
  readonly name: string;
  readonly autoDetect?: {
    readonly binEnv: string;
    readonly installCommand: string;
  };
  readonly modelEnv?: string;
  readonly envAllowlist: readonly string[];
  readonly authFiles: readonly string[];
  readonly envConfigFiles: readonly string[];
}

// Order preserves CLI diagnostics and the existing auto-detection priority.
// Omit autoDetect for runners that must be selected explicitly.
export const RUNNER_DEFINITIONS = [
  {
    name: "codex",
    autoDetect: {
      binEnv: "CODEX_BIN",
      installCommand: "npm install -g @openai/codex",
    },
    modelEnv: "CODEX_MODEL",
    envAllowlist: ["CODEX_BIN", "CODEX_MODEL", "CODEX_PROXY_API_KEY", "CODEX_REASONING_EFFORT", "CODEX_RETRY_MS", "CODEX_TIMEOUT_MS"],
    authFiles: [".codex/auth.json", ".codex/config.toml"],
    envConfigFiles: [], // Codex always passes --ignore-user-config.
  },
  {
    name: "claude",
    autoDetect: {
      binEnv: "CLAUDE_BIN",
      installCommand: "npm install -g @anthropic-ai/claude-code",
    },
    modelEnv: "CLAUDE_MODEL",
    envAllowlist: ["CLAUDE_BIN", "CLAUDE_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    authFiles: [],
    envConfigFiles: [],
  },
  {
    name: "opencode",
    autoDetect: {
      binEnv: "OPENCODE_BIN",
      installCommand: "npm install -g opencode-ai",
    },
    modelEnv: "OPENCODE_MODEL",
    envAllowlist: ["OPENCODE_BIN", "OPENCODE_MODEL", "OPENAI_API_KEY"],
    authFiles: [".config/opencode/opencode.json", ".local/share/opencode/auth.json"],
    envConfigFiles: [".config/opencode/opencode.json"],
  },
  {
    name: "openai",
    modelEnv: "OPENAI_MODEL",
    envAllowlist: [],
    authFiles: [],
    envConfigFiles: [],
  },
  {
    name: "grok",
    modelEnv: "GROK_MODEL",
    envAllowlist: ["GROK_BIN", "GROK_MODEL"],
    authFiles: [".grok/auth.json", ".grok/config.toml"],
    envConfigFiles: [".grok/config.toml"],
  },
  {
    name: "pi",
    modelEnv: "PI_MODEL",
    envAllowlist: ["PI_BIN", "PI_MODEL", "PI_PROVIDER", "PI_AUTH_MODE"],
    authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
    envConfigFiles: [".pi/agent/models.json"],
  },
  {
    name: "acp",
    envAllowlist: ["NEEDLEFISH_ACP_BIN"],
    authFiles: [],
    envConfigFiles: [],
  },
] as const satisfies readonly RunnerDefinition[];
