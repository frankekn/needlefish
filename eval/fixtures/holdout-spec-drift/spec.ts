import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (P9). Never used while iterating on
// prompt wording — only run at final gates. See eval/RESULTS.md.
const spec: FixtureSpec = {
  id: "holdout-spec-drift",
  kind: "positive",
  tier: 2,
  defectClass: "spec-impl-drift-doc-trust",
  holdout: true,
  description:
    "Doc comment promises the list is capped at `limit` entries; the diff rewrites the body and drops the cap while keeping the doc. The caller sizes a fixed buffer from the documented cap.",
  baseFiles: {
    "src/feed.ts": `/** Returns at most \`limit\` entries, newest first. */
export function recentEntries(all: string[], limit: number): string[] {
  return [...all].reverse().slice(0, limit);
}

export function renderFeed(all: string[]): string[] {
  const page = recentEntries(all, 20);
  const out = new Array<string>(20);
  for (let i = 0; i < page.length; i++) out[i] = page[i];
  return out;
}
`,
  },
  headFiles: {
    "src/feed.ts": `/** Returns at most \`limit\` entries, newest first. */
export function recentEntries(all: string[], limit: number): string[] {
  const sorted = [...all].reverse();
  if (limit <= 0) return [];
  return sorted;
}

export function renderFeed(all: string[]): string[] {
  const page = recentEntries(all, 20);
  const out = new Array<string>(20);
  for (let i = 0; i < page.length; i++) out[i] = page[i];
  return out;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "at most|uncapped|cap|slice|truncat|spec.?drift|doc.{0,32}(promis|say|limit|cap)|contract|limit.{0,28}(dropp|ignor|remov|no longer|not.{0,8}appl)|exceed.{0,16}limit|buffer" },
    ],
    anchorFile: "src/feed.ts",
    anchorLineRange: [1, 6],
  },
};

export default spec;
