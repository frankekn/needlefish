import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "neg-dep-patch",
  kind: "negative",
  defectClass: "dependency-patch-no-api-change",
  description: "A dependency is bumped from 1.2.0 to 1.2.1 (patch). No invoked API or contract change.",
  baseFiles: {
    "package.json": `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "1.2.0"
  }
}
`,
  },
  headFiles: {
    "package.json": `{
  "name": "demo",
  "version": "1.0.0",
  "dependencies": {
    "lodash": "1.2.1"
  }
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
