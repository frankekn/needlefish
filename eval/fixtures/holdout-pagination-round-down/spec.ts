import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time. Never run during iteration; first model
// exposure is the holdout-included final production gate.
const spec: FixtureSpec = {
  id: "holdout-pagination-round-down",
  kind: "positive",
  tier: 2,
  defectClass: "pagination-rounds-down",
  holdout: true,
  description:
    "The diff changes a pagination page-count calculation from ceiling to floor, dropping the final partial page and reporting zero pages when the item count is below one page.",
  baseFiles: {
    "src/pagination.ts": `export function pageCount(totalItems: number, pageSize: number): number {
  if (pageSize <= 0) throw new Error("pageSize must be positive");
  return Math.ceil(totalItems / pageSize);
}
`,
  },
  headFiles: {
    "src/pagination.ts": `export function pageCount(totalItems: number, pageSize: number): number {
  if (pageSize <= 0) throw new Error("pageSize must be positive");
  return Math.floor(totalItems / pageSize);
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        facts: [
          {
            id: "page_count_rounds_down",
            meaning: "The page count rounds down instead of up.",
            alternatives: [
              { allOf: ["page", "(?:round|floor).{0,12}down"] },
              { allOf: ["page", "Math\\.floor"] },
              { allOf: ["Math\\.ceil", "Math\\.floor"] },
            ],
          },
          {
            id: "partial_page_is_lost",
            meaning: "A remainder/partial final page is omitted or a small result becomes zero pages.",
            alternatives: [
              { allOf: ["(?:partial|last|final)", "page", "(?:drop|omit|miss|lose|lost)"] },
              { allOf: ["remainder", "page"] },
              { allOf: ["zero", "page", "(?:fewer|less|below|under)"] },
            ],
          },
        ],
      },
    ],
    anchorFile: "src/pagination.ts",
    anchorLineRange: [1, 4],
  },
};

export default spec;
