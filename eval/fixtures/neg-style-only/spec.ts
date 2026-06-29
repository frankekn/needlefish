import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-style-only",
  kind: "negative",
  defectClass: "style-only-refactor",
  description: "A pure local-variable rename with no behavior change. No bug should be reported.",
  baseFiles: {
    "src/format.ts": `export function greet(name: string): string {
  const n = name.trim();
  return "hello " + n;
}
`,
  },
  headFiles: {
    "src/format.ts": `export function greet(name: string): string {
  const trimmedName = name.trim();
  return "hello " + trimmedName;
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
