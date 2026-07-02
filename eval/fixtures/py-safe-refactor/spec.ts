import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "py-safe-refactor",
  kind: "negative",
  defectClass: "safe-local-rename",
  description: "A pure local-variable rename. No behavior change.",
  baseFiles: {
    "src/greet.py": `def greet(name):
    n = name.strip()
    return "hello " + n
`,
  },
  headFiles: {
    "src/greet.py": `def greet(name):
    trimmed = name.strip()
    return "hello " + trimmed
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
