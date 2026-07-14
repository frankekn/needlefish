import type { Report } from "./types";

// Reports are read from unvalidated JSON. The aggregate is trustworthy only
// when it exactly accounts for every per-draw detection.
export function hasConsistentCheatDetection(report: Report): boolean {
  const count = report.aggregates?.cheatDetectedCount as number | undefined;
  const detections = report.results.map(
    (result) => (result.score as { cheatDetected?: unknown }).cheatDetected,
  );
  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    detections.every((detected) => typeof detected === "boolean") &&
    count === detections.filter((detected) => detected).length
  );
}
