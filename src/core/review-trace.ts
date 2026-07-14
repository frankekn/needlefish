import type { Finding, MapResult, RawReview } from "../shared/schema.js";

export type ReviewTraceSurface =
	| "raw_success"
	| "raw_failure"
	| "candidate_finding"
	| "candidate_review_text"
	| "final_finding"
	| "final_review_text";

export type ReviewTracePassKind = "review" | "map" | "deep" | "critic";

export type ReviewTraceOutcome =
	| "parsed"
	| "parse_failed"
	| "runner_failed";

export type ReviewTraceFindingSnapshot = Pick<
	Finding,
	"category" | "file" | "lineStart" | "title" | "whyItBreaks"
>;

interface ReviewTraceEventBase {
	readonly content: string;
	readonly passKind: ReviewTracePassKind;
	readonly passIndex: number;
	readonly promptAttempt: number;
	readonly runnerAttempt: number;
	readonly outcome: ReviewTraceOutcome;
}

export interface ReviewTraceFindingEvent extends ReviewTraceEventBase {
	readonly surface: "candidate_finding" | "final_finding";
	readonly finding: ReviewTraceFindingSnapshot;
}

export interface ReviewTraceTextEvent extends ReviewTraceEventBase {
	readonly surface:
		| "raw_success"
		| "raw_failure"
		| "candidate_review_text"
		| "final_review_text";
	readonly finding?: never;
}

export type ReviewTraceEvent =
	| ReviewTraceFindingEvent
	| ReviewTraceTextEvent;

export type ReviewTraceObserver = (
	event: ReviewTraceEvent,
) => void | Promise<void>;

export interface ReviewTraceProvenance {
	readonly passKind: ReviewTracePassKind;
	readonly passIndex: number;
	readonly promptAttempt: number;
	readonly runnerAttempt: number;
}

interface CandidateReviewTrace {
	readonly observer?: ReviewTraceObserver;
	readonly review: RawReview;
	readonly provenance: ReviewTraceProvenance;
}

interface MapCandidateTrace {
	readonly observer?: ReviewTraceObserver;
	readonly mapResult: MapResult;
	readonly provenance: ReviewTraceProvenance;
}

interface FinalReviewTrace extends CandidateReviewTrace {
	readonly summary: string;
}

// Delivers a frozen event. Errors propagate: callers that must isolate review
// semantics from telemetry faults (review()) wrap the observer and record
// delivery health instead of swallowing here. Silent discard made incomplete
// robustness streams indistinguishable from healthy ones.
export function observeReviewTrace(
	observer: ReviewTraceObserver | undefined,
	event: ReviewTraceEvent,
): void {
	if (!observer) return;
	observer(Object.freeze(event));
}

function snapshotFinding(finding: Finding): ReviewTraceFindingSnapshot {
	return Object.freeze({
		category: finding.category,
		file: finding.file,
		lineStart: finding.lineStart,
		title: finding.title,
		whyItBreaks: finding.whyItBreaks,
	});
}

export function observeCandidateReviewTrace({
	observer,
	review,
	provenance,
}: CandidateReviewTrace): void {
	if (!observer) return;
	for (const finding of review.findings) {
		observeReviewTrace(observer, {
			content: JSON.stringify(finding),
			surface: "candidate_finding",
			finding: snapshotFinding(finding),
			outcome: "parsed",
			...provenance,
		});
	}
	observeReviewTrace(observer, {
		content: JSON.stringify({
			summary: review.summary,
			checked: review.checked,
			residual_risks: review.residual_risks,
		}),
		surface: "candidate_review_text",
		outcome: "parsed",
		...provenance,
	});
}

export function observeMapCandidateTrace({
	observer,
	mapResult,
	provenance,
}: MapCandidateTrace): void {
	if (!observer) return;
	observeReviewTrace(observer, {
		content: JSON.stringify(mapResult),
		surface: "candidate_review_text",
		outcome: "parsed",
		...provenance,
	});
}

export function observeFinalReviewTrace({
	observer,
	review,
	summary,
	provenance,
}: FinalReviewTrace): void {
	if (!observer) return;
	for (const finding of review.findings) {
		observeReviewTrace(observer, {
			content: JSON.stringify(finding),
			surface: "final_finding",
			finding: snapshotFinding(finding),
			outcome: "parsed",
			...provenance,
		});
	}
	observeReviewTrace(observer, {
		content: JSON.stringify({
			summary,
			checked: review.checked,
			residual_risks: review.residual_risks,
		}),
		surface: "final_review_text",
		outcome: "parsed",
		...provenance,
	});
}
