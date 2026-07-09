import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "py-data-partial-state",
  kind: "positive",
  tier: 2,
  defectClass: "pandas-in-place-mutation",
  description: "Agent optimizes a transform by dropping the defensive .copy(); the function now mutates the caller's DataFrame in place and returns it, corrupting upstream data.",
  baseFiles: {
    "src/transform.py": `import pandas as pd


def apply_values(df, mapping):
    result = df.copy()
    for key, value in mapping.items():
        result.loc[result["key"] == key, "value"] = value
    return result
`,
  },
  headFiles: {
    "src/transform.py": `import pandas as pd


def apply_values(df, mapping):
    for key, value in mapping.items():
        df.loc[df["key"] == key, "value"] = value
    return df
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "copy|in.?place|mutate|side.?effect|caller|input|original|upstream|corrupt" },
    ],
    anchorFile: "src/transform.py",
    anchorLineRange: [4, 7],
  },
};

export default spec;
