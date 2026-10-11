import type { FixtureSpec } from "../../shared/types";

// Sealed before the round-3 critic contract-drift gate. A rename newly promises
// a range bound over an unchanged body; the caller sizes a progress bar from it.
const spec: FixtureSpec = {
  id: "holdout-clamp-rename-drift",
  kind: "positive",
  tier: 2,
  defectClass: "spec-impl-drift-range-trust",
  holdout: true,
  description:
    "An exported helper is renamed from toPercent to clampPercent, promising a 0..100 result, but the body still returns the raw ratio times 100. The caller repeats a bar character by that value, which throws on negative counts and overflows past 100.",
  baseFiles: {
    "src/progress.ts": `export function toPercent(done: number, total: number): number {
  return Math.round((done / total) * 100);
}

export function progressBar(done: number, total: number): string {
  const pct = toPercent(done, total);
  return "#".repeat(pct) + "-".repeat(100 - pct);
}
`,
  },
  headFiles: {
    "src/progress.ts": `export function clampPercent(done: number, total: number): number {
  return Math.round((done / total) * 100);
}

export function progressBar(done: number, total: number): string {
  const pct = clampPercent(done, total);
  return "#".repeat(pct) + "-".repeat(100 - pct);
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "clamp|0.{0,6}100|range|bound|exceed|negative|over.?flow|RangeError|not.{0,24}(clamp|limit|bound)|name.{0,24}(promis|suggest|impl)|spec.?drift" },
    ],
    anchorFile: "src/progress.ts",
    anchorLineRange: [1, 3],
  },
};

export default spec;
