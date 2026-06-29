import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "ts-data-duplicate",
  kind: "positive",
  defectClass: "duplicate-reinvented-config",
  description: "Agent adds a retries config and a retryBackground function that reimplements the existing maxAttempts retry loop, creating two divergent sources of truth. Includes a benign timeoutMs -> timeout rename as noise.",
  baseFiles: {
    "src/retry.ts": `export interface Config {
  maxAttempts: number;
  timeoutMs: number;
}

export function retry(fn: () => void, config: Config): void {
  const deadline = Date.now() + config.timeoutMs;
  for (let i = 0; i < config.maxAttempts; i++) {
    if (Date.now() > deadline) return;
    try {
      fn();
      return;
    } catch {
      continue;
    }
  }
}
`,
  },
  headFiles: {
    "src/retry.ts": `export interface Config {
  maxAttempts: number;
  retries: number;
  timeout: number;
}

export function retry(fn: () => void, config: Config): void {
  const deadline = Date.now() + config.timeout;
  for (let i = 0; i < config.maxAttempts; i++) {
    if (Date.now() > deadline) return;
    try {
      fn();
      return;
    } catch {
      continue;
    }
  }
}

export function retryBackground(fn: () => void, config: Config): void {
  const deadline = Date.now() + config.timeout;
  for (let i = 0; i < config.retries; i++) {
    if (Date.now() > deadline) return;
    try {
      fn();
      return;
    } catch {
      continue;
    }
  }
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "duplicate|retries|maxAttempts|reimplement|diverg|two.*config|repeat|same.*concept" },
    ],
    anchorFile: "src/retry.ts",
    anchorLineRange: [20, 30],
  },
};

export default spec;
