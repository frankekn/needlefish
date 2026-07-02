import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "rs-missing-tests-no-bug",
  kind: "negative",
  defectClass: "missing-tests-no-bug-path",
  description: "A pure refactor extracts a helper. No behavior change. No tests are added, but there is no concrete bug path.",
  baseFiles: {
    "src/format.rs": `pub fn trim(s: &str) -> &str {
    s.trim()
}
`,
  },
  headFiles: {
    "src/format.rs": `pub fn trim(s: &str) -> &str {
    normalize(s)
}

fn normalize(s: &str) -> &str {
    s.trim()
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
