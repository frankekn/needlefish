import type { FixtureSpec } from "../../shared/types";

// Two independent defects a few lines apart in ONE file, both plain
// correctness bugs, introduced by the same "simplify the helpers" diff. Unlike
// t3-multi-bug (one defect per file), the two findings here share a file and
// almost certainly a category, and their anchors sit four lines apart — close
// enough that a reviewer re-anchoring either one lands within a couple of
// lines of the other. Each mustFind spec is pinned to its own function's line
// range, so a single finding cannot satisfy both: recall requires reporting
// the two defects separately.
const spec: FixtureSpec = {
  id: "t3-neighbor-defects",
  kind: "positive",
  tier: 3,
  defectClass: "adjacent-independent-defects-one-file",
  description:
    "A helper cleanup drops two different safeguards in neighbouring functions of the same file: averageAmount loses its empty-input guard and now divides by zero (returns NaN instead of 0), and busiest loses its defensive copy and now sorts the caller's array in place, reordering the input as a side effect.",
  baseFiles: {
    "src/stats.ts": `export interface Row {
  id: string;
  amount: number;
}

export function averageAmount(rows: Row[]): number {
  if (rows.length === 0) return 0;
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return total / rows.length;
}

export function busiest(rows: Row[]): Row | null {
  const ranked = [...rows].sort((a, b) => b.amount - a.amount);
  return ranked[0] ?? null;
}
`,
  },
  headFiles: {
    "src/stats.ts": `export interface Row {
  id: string;
  amount: number;
}

export function averageAmount(rows: Row[]): number {
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  return total / rows.length;
}

export function busiest(rows: Row[]): Row | null {
  return rows.sort((a, b) => b.amount - a.amount)[0] ?? null;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        pattern:
          "divide|division|divid|zero|empty|nan|not a number|no rows|length\\s*===?\\s*0|guard",
        file: "src/stats.ts",
        lineRange: [6, 9],
      },
      {
        pattern:
          "sort|mutat|in.?place|defensive copy|copies|copy|side.?effect|reorder|caller",
        file: "src/stats.ts",
        lineRange: [10, 13],
      },
    ],
  },
};

export default spec;
