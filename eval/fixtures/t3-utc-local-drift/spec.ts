import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (round 2, 2026-07-09). Never used while
// iterating on prompt wording — only run at final gates.
// Difficulty: getUTCFullYear/getUTCMonth/getUTCDate become their local-time
// twins inside a cosmetic formatting refactor. Correct on UTC servers and in
// most tests; billing day boundaries shift in any non-UTC deployment.
const spec: FixtureSpec = {
  id: "t3-utc-local-drift",
  kind: "positive",
  tier: 3,
  holdout: true,
  defectClass: "utc-to-local-time-drift",
  description:
    "billingDay() refactor swaps getUTC* accessors for local-time getFullYear/getMonth/getDate. Day boundaries now depend on server timezone; invoices near midnight land on the wrong day outside UTC.",
  baseFiles: {
    "src/billing/day.ts": `export function billingDay(at: Date): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  const d = String(at.getUTCDate()).padStart(2, "0");
  return \`\${y}-\${m}-\${d}\`;
}

export function sameBillingDay(a: Date, b: Date): boolean {
  return billingDay(a) === billingDay(b);
}
`,
  },
  headFiles: {
    "src/billing/day.ts": `const pad = (n: number): string => String(n).padStart(2, "0");

export function billingDay(at: Date): string {
  return [at.getFullYear(), pad(at.getMonth() + 1), pad(at.getDate())].join("-");
}

export function sameBillingDay(a: Date, b: Date): boolean {
  return billingDay(a) === billingDay(b);
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "UTC|time.?zone|local.{0,12}time|getDate|getFullYear|server.{0,16}(zone|time)|midnight|day.{0,16}boundar|environment.{0,16}depend" },
    ],
    anchorFile: "src/billing/day.ts",
    anchorLineRange: [1, 6],
  },
};

export default spec;
