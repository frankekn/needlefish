import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-swallowed-settlement-error",
  kind: "positive",
  tier: 1,
  defectClass: "error-swallow-payment-path",
  holdout: true,
  description: "Synthetic settlement reports success after the processor rejects a debit.",
  baseFiles: {
    "README.md": `settle returns settled only after debit resolves. A rejected debit must reject settle so the caller does not release paid goods.
`,
    "settlement.mjs": `export async function settle(debit) {
  try {
    await debit();
    return "settled";
  } catch (error) {
    throw error;
  }
}
`,
  },
  headFiles: {
    "settlement.mjs": `export async function settle(debit) {
  try {
    await debit();
    return "settled";
  } catch (error) {
    return "settled";
  }
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "swallow|false.{0,20}success|settled|fail.{0,30}(success|payment)|reject.{0,30}(success|debit)|unpaid", file: "settlement.mjs", lineRange: [6, 6] }],
    anchorFile: "settlement.mjs",
    anchorLineRange: [6, 6],
  },
};

export default spec;
