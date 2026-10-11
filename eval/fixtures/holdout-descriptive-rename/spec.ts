import type { FixtureSpec } from "../../shared/types";

// Sealed before the critic contract-drift clarification gate. A rename that
// only describes what the unchanged body already does promises nothing new;
// it must stay clean when the critic keeps rename-introduced broken promises.
const spec: FixtureSpec = {
  id: "holdout-descriptive-rename",
  kind: "negative",
  holdout: true,
  defectClass: "descriptive-rename-no-promise",
  description: "An exported helper is renamed from a terse name to a descriptive one that accurately states what the unchanged body computes. No caller-visible behavior changes and the new name promises nothing the body does not do.",
  baseFiles: {
    "src/orders.ts": `export function calc(prices: number[]): number {
  let sum = 0;
  for (const price of prices) sum += price;
  return sum;
}

export function orderTotal(prices: number[]): string {
  return calc(prices).toFixed(2);
}
`,
  },
  headFiles: {
    "src/orders.ts": `export function sumPrices(prices: number[]): number {
  let sum = 0;
  for (const price of prices) sum += price;
  return sum;
}

export function orderTotal(prices: number[]): string {
  return sumPrices(prices).toFixed(2);
}
`,
  },
  expected: { verdict: "pass", noBlockingFindings: true },
};

export default spec;
