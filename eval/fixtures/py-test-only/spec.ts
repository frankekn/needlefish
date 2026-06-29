import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "py-test-only",
  kind: "negative",
  defectClass: "test-only",
  description: "Only a test file changes (adds an assertion). No source code change.",
  baseFiles: {
    "src/calc.py": `def add(a, b):
    return a + b
`,
    "tests/test_calc.py": `from src.calc import add


def test_add():
    assert add(1, 2) == 3
`,
  },
  headFiles: {
    "tests/test_calc.py": `from src.calc import add


def test_add():
    assert add(1, 2) == 3
    assert add(0, 0) == 0
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
