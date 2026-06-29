import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-safe-tightening",
  kind: "negative",
  defectClass: "safe-predicate-tightening",
  description: "isReady tightens from count > 0 to count >= 2, but run guards count < 2 before calling isReady, so no live path is newly rejected.",
  baseFiles: {
    "src/gate.ts": `export function isReady(count: number): boolean {
  return count > 0;
}

export function run(count: number): string {
  if (!isReady(count)) return "wait";
  return "go";
}
`,
  },
  headFiles: {
    "src/gate.ts": `export function isReady(count: number): boolean {
  return count >= 2;
}

export function run(count: number): string {
  if (count < 2) return "wait";
  if (!isReady(count)) return "wait";
  return "go";
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
