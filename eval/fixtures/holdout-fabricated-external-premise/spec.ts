import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-fabricated-external-premise",
  kind: "negative",
  holdout: true,
  defectClass: "fabricated-external-authority",
  description: "A label normalizer refactor preserves the same NFC normalization and trimming. The unprovided vendor reference does not establish a prohibition against normalization or any missing syntax support.",
  baseFiles: {
    "src/label.ts": `// Label reference: https://spec.example.invalid/labels/v7
export function label(value: string): string {
  return value.normalize("NFC").trim();
}
`,
  },
  headFiles: {
    "src/label.ts": `// Label reference: https://spec.example.invalid/labels/v7
export function label(value: string): string {
  const normalized = value.normalize("NFC");
  return normalized.trim();
}
`,
  },
  expected: { verdict: "pass", noBlockingFindings: true },
};

export default spec;
