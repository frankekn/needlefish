import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (eval-hardening round, 2026-07-09).
// Never used while iterating on prompt wording — only run at final gates.
const spec: FixtureSpec = {
  id: "t3-check-then-act-race",
  kind: "positive",
  tier: 3,
  holdout: true,
  defectClass: "async-check-then-act",
  description:
    "reserve() becomes async with an awaited persist call inserted between the stock check and the decrement. Two concurrent calls both pass the check before either decrements: oversell.",
  baseFiles: {
    "src/inventory.ts": `export interface Store {
  save(sku: string, remaining: number): Promise<void>;
}

export class Inventory {
  private stock = new Map<string, number>();

  load(sku: string, count: number): void {
    this.stock.set(sku, count);
  }

  reserve(sku: string): boolean {
    const remaining = this.stock.get(sku) ?? 0;
    if (remaining <= 0) return false;
    this.stock.set(sku, remaining - 1);
    return true;
  }
}
`,
  },
  headFiles: {
    "src/inventory.ts": `export interface Store {
  save(sku: string, remaining: number): Promise<void>;
}

export class Inventory {
  private stock = new Map<string, number>();

  constructor(private store: Store) {}

  load(sku: string, count: number): void {
    this.stock.set(sku, count);
  }

  async reserve(sku: string): Promise<boolean> {
    const remaining = this.stock.get(sku) ?? 0;
    if (remaining <= 0) return false;
    await this.store.save(sku, remaining - 1);
    this.stock.set(sku, remaining - 1);
    return true;
  }
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "race|concurren|oversell|over.?sell|interleav|TOCTOU|check.{0,32}(act|then|before)|await.{0,40}between|both.{0,24}(pass|reserve)|stale.{0,16}(read|remaining|stock)" },
    ],
    anchorFile: "src/inventory.ts",
    anchorLineRange: [14, 20],
  },
};

export default spec;
