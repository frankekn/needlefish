import type { FixtureSpec } from "../../shared/types";

// Cross-file fixture: the diff touches backoff.ts and poll.ts only; the bug
// manifests in jobs/retry.ts, which the diff never touches. No anchorFile on
// purpose — a correct finding may legitimately anchor at the provider (unit
// change) or at the stale caller.
const spec: FixtureSpec = {
  id: "t3-cross-file-unit-drift",
  kind: "positive",
  tier: 3,
  defectClass: "cross-file-unit-contract-break",
  description:
    "backoff() silently changes from seconds to milliseconds and the diff updates one of its two callers. The untouched caller in jobs/retry.ts still multiplies by 1000, sleeping 1000x too long.",
  baseFiles: {
    "src/config/backoff.ts": `export function backoff(attempt: number): number {
  return Math.min(30, 2 ** attempt);
}
`,
    "src/net/poll.ts": `import { backoff } from "../config/backoff";

export function schedulePoll(attempt: number, cb: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(cb, backoff(attempt) * 1000);
}
`,
    "src/jobs/retry.ts": `import { backoff } from "../config/backoff";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(backoff(a) * 1000);
    }
  }
  throw lastErr;
}
`,
  },
  headFiles: {
    "src/config/backoff.ts": `export function backoff(attempt: number): number {
  return Math.min(30_000, 2 ** attempt * 1000);
}
`,
    "src/net/poll.ts": `import { backoff } from "../config/backoff";

export function schedulePoll(attempt: number, cb: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(cb, backoff(attempt));
}
`,
    "src/jobs/retry.ts": `import { backoff } from "../config/backoff";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  let lastErr: unknown;
  for (let a = 0; a < attempts; a++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      await sleep(backoff(a) * 1000);
    }
  }
  throw lastErr;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "retry|other caller|second caller|not updated|still multipl|1000x|unit|milli|\\* 1000" },
    ],
  },
};

export default spec;
