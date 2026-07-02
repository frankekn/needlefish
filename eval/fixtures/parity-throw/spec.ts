import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "parity-throw",
  kind: "parity",
  defectClass: "unconditional-throw",
  description: "Parity probe: a function that unconditionally throws. Any runner must catch this.",
  baseFiles: {
    "src/runner.ts": `export function execute(input: string): string {
  return input.toUpperCase();
}
`,
  },
  headFiles: {
    "src/runner.ts": `export function execute(input: string): string {
  throw new Error("always fails");
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "throw|always.?fail|unconditional" }],
    anchorFile: "src/runner.ts",
    anchorLineRange: [1, 3],
  },
};

export default spec;
