import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-missing-profile-guard",
  kind: "positive",
  tier: 1,
  defectClass: "removed-none-guard",
  holdout: true,
  description: "Synthetic customer labeling deletes the missing-profile guard and crashes for normal anonymous requests.",
  baseFiles: {
    "README.md": `A profile lookup returns None for anonymous customers. Those requests must display anonymous. Present profiles contain a display field.
`,
    "labels.py": `def label(profile):
    if profile is None:
        return "anonymous"
    return profile["display"]
`,
  },
  headFiles: {
    "labels.py": `def label(profile):
    return profile["display"]
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "None|null|missing.{0,20}profile|anonymous|TypeError|subscript", file: "labels.py", lineRange: [2, 2] }],
    anchorFile: "labels.py",
    anchorLineRange: [2, 2],
  },
};

export default spec;
