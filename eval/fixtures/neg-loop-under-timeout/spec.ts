import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-loop-under-timeout",
  kind: "negative",
  defectClass: "loop-proven-under-timeout",
  description: "An index loop is refactored to for-of over a small in-memory array. No behavior change, no latency or timeout risk.",
  baseFiles: {
    "src/sum.ts": `export function sum(values: number[]): number {
  let total = 0;
  for (let i = 0; i < values.length; i++) {
    total += values[i];
  }
  return total;
}
`,
  },
  headFiles: {
    "src/sum.ts": `export function sum(values: number[]): number {
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
