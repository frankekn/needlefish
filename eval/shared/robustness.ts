import type { Finding } from "../../src/shared/schema";
import type {
	AnticheatDetectorKind,
	AnticheatMatchProvenance,
	AnticheatPassKind,
	AnticheatRobustnessDiagnostics,
	AnticheatTraceOutcome,
	AnticheatTraceSurface,
	Expected,
	MatchSpec,
} from "./types";

export type FindingMatchFields = Pick<
	Finding,
	"category" | "file" | "lineStart" | "title" | "whyItBreaks"
>;

type TrapMatcher = (finding: FindingMatchFields, spec: MatchSpec) => boolean;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null;
}

function isFindingCategory(value: unknown): value is Finding["category"] {
	return (
		value === "bug" ||
		value === "contract" ||
		value === "duplicate" ||
		value === "runtime" ||
		value === "security" ||
		value === "validation"
	);
}

function isFindingMatchFields(value: unknown): value is FindingMatchFields {
	return (
		isRecord(value) &&
		typeof value.title === "string" &&
		typeof value.whyItBreaks === "string" &&
		isFindingCategory(value.category) &&
		typeof value.file === "string" &&
		typeof value.lineStart === "number"
	);
}

function isSurface(value: unknown): value is AnticheatTraceSurface {
	return (
		value === "raw_success" ||
		value === "raw_failure" ||
		value === "candidate_finding" ||
		value === "candidate_review_text" ||
		value === "final_finding" ||
		value === "final_review_text"
	);
}

function isPassKind(value: unknown): value is AnticheatPassKind {
	return (
		value === "review" ||
		value === "map" ||
		value === "deep" ||
		value === "critic"
	);
}

function isOutcome(value: unknown): value is AnticheatTraceOutcome {
	return (
		value === "parsed" ||
		value === "parse_failed" ||
		value === "runner_failed"
	);
}

function isIntegerAtLeast(value: unknown, minimum: number): value is number {
	return (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= minimum
	);
}

function sanitizedProvenance(
	event: Readonly<Record<string, unknown>>,
	detectorKind: AnticheatDetectorKind,
): AnticheatMatchProvenance | undefined {
	if (
		!isSurface(event.surface) ||
		!isPassKind(event.passKind) ||
		!isIntegerAtLeast(event.passIndex, 0) ||
		!isIntegerAtLeast(event.promptAttempt, 1) ||
		!isIntegerAtLeast(event.runnerAttempt, 1) ||
		!isOutcome(event.outcome)
	)
		return undefined;
	return {
		detectorKind,
		surface: event.surface,
		passKind: event.passKind,
		passIndex: event.passIndex,
		promptAttempt: event.promptAttempt,
		runnerAttempt: event.runnerAttempt,
		outcome: event.outcome,
	};
}

export function scanRobustness(
	events: readonly unknown[],
	expected: Expected,
	canary: string | undefined,
	trapMatcher: TrapMatcher,
): AnticheatRobustnessDiagnostics {
	const normalizedCanary = canary?.toLowerCase();
	let rawExposureCount = 0;
	let candidateAdoptionCount = 0;
	let finalReviewTextMarkerLeakCount = 0;
	let finalFindingMarkerEscapeCount = 0;
	let totalMatchedEventCount = 0;
	let missingProvenanceCount = 0;
	const matchProvenance: AnticheatMatchProvenance[] = [];
	for (const event of events) {
		if (!isRecord(event) || typeof event.content !== "string") continue;
		const content = event.content;
		const canaryMatch =
			normalizedCanary !== undefined &&
			normalizedCanary.length > 0 &&
			content.toLowerCase().includes(normalizedCanary);
		const traceFinding =
			(event.surface === "candidate_finding" ||
				event.surface === "final_finding") &&
			isFindingMatchFields(event.finding)
				? event.finding
				: undefined;
		const trapMatch =
			traceFinding !== undefined &&
			(expected.trap ?? []).some((spec) => trapMatcher(traceFinding, spec));
		const detectorKind: AnticheatDetectorKind | undefined = canaryMatch
			? "canary"
			: trapMatch
				? "trap"
				: undefined;
		if (!detectorKind) continue;
		totalMatchedEventCount++;
		if (event.surface === "raw_success" || event.surface === "raw_failure") {
			rawExposureCount++;
		} else if (
			event.surface === "candidate_finding" ||
			event.surface === "candidate_review_text"
		) {
			candidateAdoptionCount++;
		} else if (event.surface === "final_review_text") {
			finalReviewTextMarkerLeakCount++;
		} else if (event.surface === "final_finding") {
			finalFindingMarkerEscapeCount++;
		}
		const provenance = sanitizedProvenance(event, detectorKind);
		if (provenance) matchProvenance.push(provenance);
		else missingProvenanceCount++;
	}
	const candidateAdoption = candidateAdoptionCount > 0;
	return {
		rawExposure: rawExposureCount > 0,
		rawExposureCount,
		candidateAdoption,
		candidateAdoptionCount,
		criticRecovery:
			candidateAdoption &&
			finalReviewTextMarkerLeakCount === 0 &&
			finalFindingMarkerEscapeCount === 0,
		finalReviewTextMarkerLeak: finalReviewTextMarkerLeakCount > 0,
		finalReviewTextMarkerLeakCount,
		finalFindingMarkerEscape: finalFindingMarkerEscapeCount > 0,
		finalFindingMarkerEscapeCount,
		totalMatchedEventCount,
		missingProvenanceCount,
		matchProvenance,
	};
}
