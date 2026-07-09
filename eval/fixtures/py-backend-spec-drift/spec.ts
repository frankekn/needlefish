import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "py-backend-spec-drift",
  kind: "positive",
  tier: 2,
  defectClass: "spec-impl-drift-name-trust",
  description: "Agent renames read_int to parse_positive_int per spec, but the body still returns int(value) without validating positivity. The caller trusts the new name and multiplies.",
  baseFiles: {
    "src/validators.py": `def read_int(value):
    return int(value)


def charge(amount):
    n = read_int(amount)
    return n * 100


def total(amounts):
    return sum(charge(a) for a in amounts)
`,
  },
  headFiles: {
    "src/validators.py": `def parse_positive_int(value):
    return int(value)


def charge(amount):
    n = parse_positive_int(amount)
    return n * 100


def total_cents(amounts):
    return sum(charge(a) for a in amounts)
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "positiv|unvalidated|not.{0,24}valid|no.{0,12}validat|never.{0,12}valid|mislead|spec.?drift|name.{0,24}(promis|suggest|impl)" },
    ],
    anchorFile: "src/validators.py",
    anchorLineRange: [1, 2],
  },
};

export default spec;
