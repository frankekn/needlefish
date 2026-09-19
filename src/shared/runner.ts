import { RUNNER_DEFINITIONS } from "./runner-definition.js";

export type RunnerName = (typeof RUNNER_DEFINITIONS)[number]["name"];

export const RUNNERS: readonly RunnerName[] = RUNNER_DEFINITIONS.map(({ name }) => name);

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

export function isRunnerName(value: string): value is RunnerName {
  return RUNNER_DEFINITIONS.some(({ name }) => name === value);
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
