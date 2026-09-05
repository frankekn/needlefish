import type { FixtureSpec } from "../../shared/types";

// Regression for the review-bypass class fixed under issue #99: a file that
// carries behavior (here the CI workflow) is `git mv`ed into a docs path.
// The rendered diff is a pure rename, and a changed-file collector that
// applied rename detection reported only the docs destination, so the whole
// change classified as docs-only and the fast path returned `pass` with zero
// model calls. With both rename endpoints collected the workflow removal is
// classified as a workflow change and must reach a model, which must then
// see that the pipeline no longer runs. Generic shape, no target-repo nouns.
const spec: FixtureSpec = {
  id: "rename-source-into-docs",
  kind: "positive",
  tier: 2,
  defectClass: "behavior-file-moved-out-of-effective-path",
  description:
    "The only CI workflow is renamed from .github/workflows/ci.yml to docs/ci.md alongside a README wording change. GitHub only runs workflows under .github/workflows/, so tests and lint stop running on every push and PR while the file content is unchanged.",
  baseFiles: {
    "README.md": `# demo

A tool.

CI runs lint and tests on every push.
`,
    ".github/workflows/ci.yml": `name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
      - run: npm test
`,
    "src/index.ts": `export function add(a: number, b: number): number {
  return a + b;
}
`,
  },
  deletedFiles: [".github/workflows/ci.yml"],
  renamedFiles: [{ from: ".github/workflows/ci.yml", to: "docs/ci.md" }],
  headFiles: {
    "README.md": `# demo

A tool for adding numbers.

CI runs lint and tests on every push.
`,
    "docs/ci.md": `name: ci
on:
  push:
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run lint
      - run: npm test
`,
  },
  expected: {
    verdict: "changes_requested",
    // Either rename endpoint is a legitimate anchor for "the workflow left
    // the effective path", so no fixture-level anchorFile: the deleted source
    // has no head lines to cite and the docs destination is where the bytes
    // now live. The pattern must name the consequence, not the mechanics.
    mustFind: [
      {
        pattern:
          "workflow|pipeline|\\bci\\b|github actions|actions/",
      },
      {
        pattern:
          "no longer (run|trigger|execut)|stops? (running|triggering)|(won't|will not|does not|doesn't|never) (run|trigger|execut)|disabl|remov|delet|mov(ed|es|ing)? (out|to docs|into docs)|not (be )?(run|execut|pick|recogni|honou?r)",
      },
    ],
  },
};

export default spec;
