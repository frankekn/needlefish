import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-test-only",
  kind: "negative",
  defectClass: "test-only",
  description: "Only a test file changes (adds a test case). No source code change.",
  baseFiles: {
    "src/calc.ts": `export function add(a: number, b: number): number {
  return a + b;
}
`,
    "src/calc.test.ts": `import { add } from "./calc";
import assert from "node:assert";
assert.equal(add(1, 2), 3);
`,
  },
  headFiles: {
    "src/calc.test.ts": `import { add } from "./calc";
import assert from "node:assert";
assert.equal(add(1, 2), 3);
assert.equal(add(0, 0), 0);
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
