import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "t1-hardcoded-secret",
  kind: "positive",
  tier: 1,
  defectClass: "hardcoded-credential",
  description:
    "The diff replaces the env-var lookup with a hardcoded live API key committed to source, 'to fix CI'. Blatant credential leak.",
  baseFiles: {
    "src/billing/client.ts": `export interface BillingClient {
  key: string;
  endpoint: string;
}

export function makeClient(): BillingClient {
  const key = process.env.BILLING_API_KEY;
  if (!key) throw new Error("BILLING_API_KEY is not set");
  return { key, endpoint: "https://api.billing.example.com/v2" };
}
`,
  },
  headFiles: {
    "src/billing/client.ts": `export interface BillingClient {
  key: string;
  endpoint: string;
}

export function makeClient(): BillingClient {
  const key = "bk_live_9f8e7d6c5b4a39281706f5e4d3c2b1a0";
  return { key, endpoint: "https://api.billing.example.com/v2" };
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "hard.?cod|secret|credential|api.?key|committed|leak|bk_live|source control|version control" },
    ],
    anchorFile: "src/billing/client.ts",
    anchorLineRange: [6, 9],
  },
};

export default spec;
