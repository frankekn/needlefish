import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-docs-only",
  kind: "negative",
  defectClass: "docs-only",
  description: "Only the README wording changes. No code change, no behavior change.",
  baseFiles: {
    "README.md": `# demo

A tool.
`,
  },
  headFiles: {
    "README.md": `# demo

A tool for processing records efficiently.
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
