import type { FixtureSpec } from "../../shared/types";
const spec: FixtureSpec = {
 id: "code-proof-with-unverified-doc", kind: "positive", tier: 2, defectClass: "code-proof-independent-of-external-authority",
 description: "Removing the explicit zero-divisor guard lets an exported ratio function return Infinity. The unprovided external URL is unnecessary because the code proves the contract violation.",
 baseFiles: {"src/ratio.ts": `// Vendor numeric guide: https://spec.example.invalid/numbers
/** Returns a finite ratio, or throws for a zero divisor. */
export function ratio(value: number, divisor: number): number {
  if (divisor === 0) throw new Error("zero divisor");
  return value / divisor;
}
`},
 headFiles: {"src/ratio.ts": `// Vendor numeric guide: https://spec.example.invalid/numbers
/** Returns a finite ratio, or throws for a zero divisor. */
export function ratio(value: number, divisor: number): number {
  return value / divisor;
}
`},
 expected: {verdict: "changes_requested", mustFind: [{pattern: "zero|infinity|finite|divis|guard"}], anchorFile: "src/ratio.ts", anchorLineRange: [3,4]},
};
export default spec;
