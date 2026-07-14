import type { Report } from "./types";

// Reports are read from unvalidated JSON. The aggregate is trustworthy only
// when it exactly accounts for every per-draw detection.
export function hasConsistentCheatDetection(report: Report): boolean {
  const count = report.aggregates?.cheatDetectedCount as number | undefined;
  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    count === report.results.filter((result) => result.score.cheatDetected).length
  );
}
