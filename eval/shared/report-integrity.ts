import { scorerHash } from "./scorer-hash";
import type { Report } from "./types";

// Reports are read from unvalidated JSON. The aggregate is trustworthy only
// when it exactly accounts for every per-draw detection.
export function hasCurrentScorer(report: Report): boolean {
  return report.scorerHash === scorerHash();
}

export function hasConsistentCheatDetection(report: Report): boolean {
  const count = report.aggregates?.cheatDetectedCount as number | undefined;
  const exposureCount = report.aggregates?.baitExposureCount as
    | number
    | undefined;
  const criticPrunedRecallCount = report.aggregates?.criticPrunedRecallCount as
    | number
    | undefined;
  const results: unknown = report.results;
  if (!Array.isArray(results)) return false;
  const detections: unknown[] = [];
  const exposures: unknown[] = [];
  let expectedCriticPrunedRecallCount = 0;
  for (const result of results) {
    if (typeof result !== "object" || result === null) return false;
    const score = (result as { score?: unknown }).score;
    if (typeof score !== "object" || score === null) return false;
    detections.push((score as { cheatDetected?: unknown }).cheatDetected);
    exposures.push((score as { baitExposed?: unknown }).baitExposed);
    const draw = result as {
      matchEvidence?: readonly { findingIndex?: unknown }[];
      candidateMatchEvidence?: readonly { findingIndex?: unknown }[];
    };
    if (Array.isArray(draw.matchEvidence)) {
      expectedCriticPrunedRecallCount += draw.matchEvidence.filter(
        (evidence, index) =>
          evidence.findingIndex === null &&
          draw.candidateMatchEvidence?.[index]?.findingIndex !== null &&
          draw.candidateMatchEvidence?.[index]?.findingIndex !== undefined,
      ).length;
    }
  }
  return (
    typeof count === "number" &&
    Number.isInteger(count) &&
    count >= 0 &&
    typeof exposureCount === "number" &&
    Number.isInteger(exposureCount) &&
    exposureCount >= 0 &&
    typeof criticPrunedRecallCount === "number" &&
    Number.isInteger(criticPrunedRecallCount) &&
    criticPrunedRecallCount >= 0 &&
    detections.every((detected) => typeof detected === "boolean") &&
    exposures.every((exposed) => typeof exposed === "boolean") &&
    count === detections.filter((detected) => detected).length &&
    exposureCount === exposures.filter((exposed) => exposed).length &&
    criticPrunedRecallCount === expectedCriticPrunedRecallCount
  );
}
