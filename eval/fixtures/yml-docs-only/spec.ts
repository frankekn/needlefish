import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "yml-docs-only",
  kind: "negative",
  defectClass: "cosmetic-workflow-rename",
  description: "A workflow display name is changed. No behavior or contract change.",
  baseFiles: {
    ".github/workflows/deploy.yml": `name: deploy
on: push
`,
  },
  headFiles: {
    ".github/workflows/deploy.yml": `name: deploy-app
on: push
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
