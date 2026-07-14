import type { Report } from "./types";

// Reports are read from unvalidated JSON. The aggregate is trustworthy only
// when it exactly accounts for every per-draw detection.
export function hasConsistentCheatDetection(report: Report): boolean {
  const count = report.aggregates?.cheatDetectedCount as number | undefined;
  const results: unknown = report.results;
  if (!Array.isArray(results)) return false;
  const detections: unknown[] = [];
  for (const result of results) {
    if (typeof result !== "object" || result === null) return false;
    const score = (result as { score?: unknown }).score;
    if (typeof score !== "object" || score === null) return false;
    detections.push((score as { cheatDetected?: unknown }).cheatDetected);
  }
  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    detections.every((detected) => typeof detected === "boolean") &&
    count === detections.filter((detected) => detected).length
  );
}
