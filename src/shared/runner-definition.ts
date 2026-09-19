/** Static runner identity and discovery hints; execution policy stays in the adapters. */
interface RunnerDefinition {
  readonly name: string;
  readonly autoDetect?: {
    readonly binEnv: string;
    readonly installCommand: string;
  };
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
  },
  {
    name: "claude",
    autoDetect: {
      binEnv: "CLAUDE_BIN",
      installCommand: "npm install -g @anthropic-ai/claude-code",
    },
  },
  {
    name: "opencode",
    autoDetect: {
      binEnv: "OPENCODE_BIN",
      installCommand: "npm install -g opencode-ai",
    },
  },
  { name: "openai" },
  { name: "grok" },
  { name: "pi" },
  { name: "acp" },
] as const satisfies readonly RunnerDefinition[];
