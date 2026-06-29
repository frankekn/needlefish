import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-harmless-default",
  kind: "negative",
  defectClass: "harmless-helper-default",
  description: "An internal helper gains an unused default parameter. No behavior change for any caller.",
  baseFiles: {
    "src/logger.ts": `export function log(message: string): void {
  console.log(message);
}
`,
  },
  headFiles: {
    "src/logger.ts": `export function log(message: string, _tag: string = "info"): void {
  console.log(message);
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
