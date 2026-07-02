import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "rs-backend-spec-drift",
  kind: "positive",
  defectClass: "spec-impl-drift-unwrap-trust",
  description: "Agent renames read_int to parse_positive_int per spec, but the body still returns parse().unwrap_or(0) with no positivity check; the caller trusts the name.",
  baseFiles: {
    "src/parse.rs": `pub fn read_int(s: &str) -> i64 {
    s.parse().unwrap_or(0)
}

pub fn charge(amount: &str) -> i64 {
    let n = read_int(amount);
    n * 100
}
`,
  },
  headFiles: {
    "src/parse.rs": `pub fn parse_positive_int(s: &str) -> i64 {
    s.parse().unwrap_or(0)
}

pub fn charge(amount: &str) -> i64 {
    let n = parse_positive_int(amount);
    n * 100
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "positive|valid|drift|negative|unwrap|trust|name|spec|assume" },
    ],
    anchorFile: "src/parse.rs",
    anchorLineRange: [1, 3],
  },
};

export default spec;
