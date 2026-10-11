import type { FixtureSpec } from "../../shared/types";

// Sealed before the second critic contract-drift gate. A public function gains
// an optional keyword argument that nothing reads and no name or doc promises
// anything about; the output for every caller is unchanged.
const spec: FixtureSpec = {
  id: "holdout-unused-keyword-arg",
  kind: "negative",
  holdout: true,
  defectClass: "harmless-unused-keyword-arg",
  description: "A public formatter gains an optional keyword argument reserved for later use. Nothing reads it, no docstring mentions it, and every existing call returns the same string.",
  baseFiles: {
    "src/report.py": `def format_row(name, value):
    return f"{name}: {value}"


def render(rows):
    return "\\n".join(format_row(n, v) for n, v in rows)
`,
  },
  headFiles: {
    "src/report.py": `def format_row(name, value, context=None):
    return f"{name}: {value}"


def render(rows):
    return "\\n".join(format_row(n, v) for n, v in rows)
`,
  },
  expected: { verdict: "pass", noBlockingFindings: true },
};

export default spec;
