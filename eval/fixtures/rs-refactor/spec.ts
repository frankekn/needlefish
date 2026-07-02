import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "rs-refactor",
  kind: "negative",
  defectClass: "safe-loop-refactor",
  description: "An index loop is refactored to an iterator loop. No behavior change.",
  baseFiles: {
    "src/sum.rs": `pub fn sum(values: &[i64]) -> i64 {
    let mut total = 0;
    for i in 0..values.len() {
        total += values[i];
    }
    total
}
`,
  },
  headFiles: {
    "src/sum.rs": `pub fn sum(values: &[i64]) -> i64 {
    let mut total = 0;
    for v in values {
        total += v;
    }
    total
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
