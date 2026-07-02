import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "go-dep-patch",
  kind: "negative",
  defectClass: "dependency-patch-no-api-change",
  description: "A Go module dependency is bumped from v1.2.0 to v1.2.1 (patch). No invoked API or contract change.",
  baseFiles: {
    "go.mod": `module demo

go 1.21

require github.com/example/lib v1.2.0
`,
  },
  headFiles: {
    "go.mod": `module demo

go 1.21

require github.com/example/lib v1.2.1
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
