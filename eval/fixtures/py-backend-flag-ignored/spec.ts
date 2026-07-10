import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "py-backend-flag-ignored",
  kind: "positive",
  tier: 2,
  defectClass: "spec-impl-drift-flag-ignored",
  description: "Agent adds a limit parameter to build per spec, but the loop still iterates over a hardcoded max_count and never reads limit.",
  baseFiles: {
    "src/builder.py": `def build(prefix):
    max_count = 10
    out = []
    for i in range(max_count):
        out.append(f"{prefix}-{i}")
    return out
`,
  },
  headFiles: {
    "src/builder.py": `def build(prefix, limit=10):
    max_count = 10
    out = []
    for i in range(max_count):
        out.append(f"{prefix}-{i}")
    return out
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "limit|max_count|ignored|hardcod|not.*used|unused|wired|never.*read" },
    ],
    anchorFile: "src/builder.py",
    anchorLineRange: [1, 6],
  },
};

export default spec;
