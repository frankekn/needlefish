/** Static runner metadata; execution and credential-selection policy stay in the adapters. */
export interface RunnerDefinition {
  readonly name: string;
  /** CLI executable: the env override and the command name used when it is unset. Absent for HTTP runners. */
  readonly bin?: {
    readonly env: string;
    readonly fallback?: string;
  };
  readonly autoDetect?: {
    readonly installCommand: string;
  };
  /** Login command and the CLI's own non-billable status probe; absent when the CLI offers none. */
  readonly login?: {
    readonly command: string;
    readonly status?: {
      readonly args: readonly string[];
      readonly loggedIn: "exit-zero" | "non-empty-json-array";
    };
  };
  readonly modelEnv?: string;
  readonly envAllowlist: readonly string[];
  readonly authFiles: readonly string[];
  readonly envConfigFiles: readonly string[];
}

// Order preserves CLI diagnostics and the existing auto-detection priority.
// Omit autoDetect for runners that must be selected explicitly.
// Login status probes were verified 2026-09-29 against codex-cli 0.158.0
// (`codex login status` exits 1 with "Not logged in"), Claude Code 2.1.284
// (`claude auth status --text` exits 1 when logged out) and opencode 2.0.18
// (`auth list --standalone --format json` prints `[]` with no credentials;
// without --standalone it waits on the background service).
export const RUNNER_DEFINITIONS = [
  {
    name: "codex",
    bin: { env: "CODEX_BIN", fallback: "codex" },
    autoDetect: { installCommand: "npm install -g @openai/codex" },
    login: {
      command: "codex login",
      status: { args: ["login", "status"], loggedIn: "exit-zero" },
    },
    modelEnv: "CODEX_MODEL",
    envAllowlist: ["CODEX_BIN", "CODEX_MODEL", "CODEX_PROXY_API_KEY", "CODEX_REASONING_EFFORT", "CODEX_RETRY_MS", "CODEX_TIMEOUT_MS"],
    authFiles: [".codex/auth.json", ".codex/config.toml"],
    envConfigFiles: [], // Codex always passes --ignore-user-config.
  },
  {
    name: "claude",
    bin: { env: "CLAUDE_BIN", fallback: "claude" },
    autoDetect: { installCommand: "npm install -g @anthropic-ai/claude-code" },
    login: {
      command: "claude auth login",
      status: { args: ["auth", "status", "--text"], loggedIn: "exit-zero" },
    },
    modelEnv: "CLAUDE_MODEL",
    envAllowlist: ["CLAUDE_BIN", "CLAUDE_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    authFiles: [],
    envConfigFiles: [],
  },
  {
    name: "opencode",
    bin: { env: "OPENCODE_BIN", fallback: "opencode" },
    autoDetect: { installCommand: "npm install -g @opencode/cli" },
    login: {
      command: "opencode auth login",
      status: {
        args: ["auth", "list", "--standalone", "--format", "json"],
        loggedIn: "non-empty-json-array",
      },
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
    bin: { env: "GROK_BIN", fallback: "grok" },
    login: { command: "grok login" },
    modelEnv: "GROK_MODEL",
    envAllowlist: ["GROK_BIN", "GROK_MODEL"],
    authFiles: [".grok/auth.json", ".grok/config.toml"],
    envConfigFiles: [".grok/config.toml"],
  },
  {
    name: "pi",
    bin: { env: "PI_BIN", fallback: "pi" },
    modelEnv: "PI_MODEL",
    envAllowlist: ["PI_BIN", "PI_MODEL", "PI_PROVIDER", "PI_AUTH_MODE"],
    authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
    envConfigFiles: [".pi/agent/models.json"],
  },
  {
    name: "acp",
    bin: { env: "NEEDLEFISH_ACP_BIN" },
    envAllowlist: ["NEEDLEFISH_ACP_BIN"],
    authFiles: [],
    envConfigFiles: [],
  },
] as const satisfies readonly RunnerDefinition[];
