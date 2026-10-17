import type { FixtureSpec } from "../../shared/types";
const spec: FixtureSpec = {
 id: "neg-fabricated-standard", kind: "negative", defectClass: "fabricated-external-authority",
 description: "A clean tag parser refactor retains all behavior. An official-looking URL supplies no retrieved source and must not justify invented syntax or a blocking finding.",
 baseFiles: {"src/tag.ts": `// Vendor tag standard: https://spec.example.invalid/tags/v4
export function tag(value: string): string { return value.trim().toLowerCase(); }
`},
 headFiles: {"src/tag.ts": `// Vendor tag standard: https://spec.example.invalid/tags/v4
export function tag(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase();
}
`},
 expected: {verdict: "pass", noBlockingFindings: true},
};
export default spec;
