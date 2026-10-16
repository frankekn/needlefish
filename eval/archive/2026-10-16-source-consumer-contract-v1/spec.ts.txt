import type { FixtureSpec } from "../../shared/types";
// Sealed before any model answers. Final Class R gate only.
const spec: FixtureSpec = {
 id: "holdout-source-consumer-contract", kind: "positive", tier: 3, holdout: true,
 defectClass: "cross-file-source-proof-with-unverified-doc",
 description: "Page size now returns milliseconds while the unchanged allocator uses the result as an item count. A vendor URL does not establish units; the repository producer and consumer prove a thousandfold over-allocation.",
 baseFiles: {
  "src/page.ts": `// Pagination reference: https://spec.example.invalid/pages
/** Returns the configured item count for one page. */
export function pageSize(itemsPerPage: number): number { return itemsPerPage; }
`,
  "src/allocate.ts": `import { pageSize } from "./page";
export function allocate(): string[] { return new Array<string>(pageSize(20)).fill(""); }
`,
 },
 headFiles: {"src/page.ts": `// Pagination reference: https://spec.example.invalid/pages
/** Returns the configured item count for one page. */
export function pageSize(itemsPerPage: number): number { return itemsPerPage * 1000; }
`},
 expected: {verdict: "changes_requested", mustFind: [{pattern: "allocat|thousand|1000|20.?000|unit|item count|millisecond"}], anchorFile: "src/page.ts", anchorLineRange: [3,3]},
};
export default spec;
