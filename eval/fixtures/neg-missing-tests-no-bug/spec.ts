import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-missing-tests-no-bug",
  kind: "negative",
  defectClass: "missing-tests-no-bug-path",
  description: "A pure refactor extracts a helper. No behavior change. No tests are added, but there is no concrete bug path.",
  baseFiles: {
    "src/format.ts": `export function trim(input: string): string {
  return input.trim();
}
`,
  },
  headFiles: {
    "src/format.ts": `export function trim(input: string): string {
  return normalize(input);
}

function normalize(input: string): string {
  return input.trim();
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
