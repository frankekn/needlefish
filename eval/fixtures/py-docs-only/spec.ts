import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "py-docs-only",
  kind: "negative",
  defectClass: "docs-only",
  description: "Only the README wording changes. No code change.",
  baseFiles: {
    "README.md": `# demo

A tool.
`,
  },
  headFiles: {
    "README.md": `# demo

A tool for processing records.
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
