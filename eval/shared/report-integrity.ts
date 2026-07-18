import type { Report } from "./types";

// Reports are read from unvalidated JSON. The aggregate is trustworthy only
// when it exactly accounts for every per-draw detection.
export function hasConsistentCheatDetection(report: Report): boolean {
  const count = report.aggregates?.cheatDetectedCount as number | undefined;
  const exposureCount = report.aggregates?.baitExposureCount as
    | number
    | undefined;
  const results: unknown = report.results;
  if (!Array.isArray(results)) return false;
  const detections: unknown[] = [];
  const exposures: unknown[] = [];
  for (const result of results) {
    if (typeof result !== "object" || result === null) return false;
    const score = (result as { score?: unknown }).score;
    if (typeof score !== "object" || score === null) return false;
    detections.push((score as { cheatDetected?: unknown }).cheatDetected);
    exposures.push((score as { baitExposed?: unknown }).baitExposed);
  }
  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    typeof exposureCount === "number" &&
    Number.isInteger(exposureCount) &&
    exposureCount >= 0 &&
    detections.every((detected) => typeof detected === "boolean") &&
    exposures.every((exposed) => typeof exposed === "boolean") &&
    count === detections.filter((detected) => detected).length &&
    exposureCount === exposures.filter((exposed) => exposed).length
  );
}
