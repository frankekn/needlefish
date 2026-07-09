import type { FixtureSpec } from "../../shared/types";

// Hard negative: a wide, scary-looking refactor — function moved to a new
// module, renamed, rewritten from if-chains to early returns and a lookup
// table — with behavior exactly preserved. The FP bait is the visual size.
const spec: FixtureSpec = {
  id: "neg-hard-refactor-move",
  kind: "negative",
  defectClass: "behavior-preserving-move-rename",
  description:
    "shipping quote logic moves from orders.ts into a new pricing/shipping.ts module, renamed and restructured with a rate table and early returns. Every input maps to the same output as before.",
  baseFiles: {
    "src/orders.ts": `export interface Order {
  weightKg: number;
  express: boolean;
  destination: "domestic" | "international";
}

export function shippingQuote(order: Order): number {
  let rate = 0;
  if (order.destination === "domestic") {
    if (order.weightKg <= 1) {
      rate = 500;
    } else if (order.weightKg <= 5) {
      rate = 900;
    } else {
      rate = 900 + Math.ceil(order.weightKg - 5) * 120;
    }
  } else {
    if (order.weightKg <= 1) {
      rate = 2200;
    } else if (order.weightKg <= 5) {
      rate = 3800;
    } else {
      rate = 3800 + Math.ceil(order.weightKg - 5) * 450;
    }
  }
  if (order.express) {
    rate = rate * 2;
  }
  return rate;
}

export function orderTotal(subtotal: number, order: Order): number {
  return subtotal + shippingQuote(order);
}
`,
  },
  headFiles: {
    "src/pricing/shipping.ts": `export interface Shippable {
  weightKg: number;
  express: boolean;
  destination: "domestic" | "international";
}

interface RateBand {
  baseLight: number;
  baseMid: number;
  perExtraKg: number;
}

const RATES: Record<Shippable["destination"], RateBand> = {
  domestic: { baseLight: 500, baseMid: 900, perExtraKg: 120 },
  international: { baseLight: 2200, baseMid: 3800, perExtraKg: 450 },
};

export function quoteShipping(item: Shippable): number {
  const band = RATES[item.destination];
  const base = baseRate(item.weightKg, band);
  return item.express ? base * 2 : base;
}

function baseRate(weightKg: number, band: RateBand): number {
  if (weightKg <= 1) return band.baseLight;
  if (weightKg <= 5) return band.baseMid;
  return band.baseMid + Math.ceil(weightKg - 5) * band.perExtraKg;
}
`,
    "src/orders.ts": `import { quoteShipping, type Shippable } from "./pricing/shipping";

export type Order = Shippable;

export function orderTotal(subtotal: number, order: Order): number {
  return subtotal + quoteShipping(order);
}
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
