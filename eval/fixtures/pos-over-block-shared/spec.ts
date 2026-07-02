import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "pos-over-block-shared",
  kind: "positive",
  defectClass: "over-block-shared-predicate",
  description: "A shared canProceed predicate is tightened for paid submission, correctly blocking submit-order but wrongly blocking save-draft.",
  baseFiles: {
    "src/policy.ts": `export interface Order {
  state: "draft" | "ready";
  payment: "missing" | "paid";
}

export function canProceed(order: Order): boolean {
  return order.state !== "ready";
}
`,
    "src/actions.ts": `import { canProceed, type Order } from "./policy";

export function submitOrder(order: Order): string {
  if (!canProceed(order)) return "blocked";
  return "submitted";
}

export function saveDraft(order: Order): string {
  if (!canProceed(order)) return "blocked";
  return "saved";
}
`,
  },
  headFiles: {
    "src/policy.ts": `export interface Order {
  state: "draft" | "ready";
  payment: "missing" | "paid";
}

export function canProceed(order: Order): boolean {
  return order.state !== "ready" && order.payment === "paid";
}
`,
    "src/actions.ts": `import { canProceed, type Order } from "./policy";

export function submitOrder(order: Order): string {
  if (!canProceed(order)) return "blocked";
  return "submitted";
}

export function saveDraft(order: Order): string {
  if (!canProceed(order)) return "blocked";
  return "saved";
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "save.?draft|draft.*blocked|canProceed|shared predicate|over.?block" },
    ],
    anchorFile: "src/policy.ts",
    anchorLineRange: [6, 6],
  },
};

export default spec;
