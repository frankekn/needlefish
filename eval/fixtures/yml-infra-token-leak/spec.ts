import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "yml-infra-token-leak",
  kind: "positive",
  defectClass: "workflow-secret-exposure",
  description: "Agent adds a deploy step that puts a secret into an env var and echoes it, leaking the token into the workflow log.",
  baseFiles: {
    ".github/workflows/deploy.yml": `name: deploy
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: make build
`,
  },
  headFiles: {
    ".github/workflows/deploy.yml": `name: deploy
on: push
permissions:
  contents: read
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - env:
          TOKEN: \${{ secrets.TOKEN }}
        run: echo "deploying with $TOKEN"
      - run: make build
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "token|secret|expos|echo|log|leak|secrets" },
    ],
    anchorFile: ".github/workflows/deploy.yml",
    anchorLineRange: [10, 12],
  },
};

export default spec;
