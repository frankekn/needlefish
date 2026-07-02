import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "go-harmless-variadic",
  kind: "negative",
  defectClass: "harmless-variadic-param",
  description: "An internal helper gains an unused variadic parameter. No behavior change for any caller.",
  baseFiles: {
    "src/logger.go": `package logger

func Log(message string) {
	println(message)
}
`,
  },
  headFiles: {
    "src/logger.go": `package logger

func Log(message string, tag ...string) {
	println(message)
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
