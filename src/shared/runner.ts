export const RUNNERS = ["codex", "claude", "opencode"] as const;

export type RunnerName = (typeof RUNNERS)[number];

export interface RunnerOptions {
  readonly runner?: RunnerName;
  readonly model?: string;
  readonly timeoutMs?: number;
  readonly reasoningEffort?: string;
}

export function isRunnerName(value: string): value is RunnerName {
  return value === "codex" || value === "claude" || value === "opencode";
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
