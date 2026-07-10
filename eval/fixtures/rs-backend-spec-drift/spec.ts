import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "rs-backend-spec-drift",
  kind: "positive",
  tier: 2,
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
      { pattern: "positiv|unwrap_or|unvalidated|not.{0,24}valid|no.{0,12}validat|never.{0,12}valid|mislead|spec.?drift|name.{0,24}(promis|suggest|impl)" },
    ],
    anchorFile: "src/parse.rs",
    anchorLineRange: [1, 3],
  },
};

export default spec;
