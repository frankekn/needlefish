import type { MapResult, RawReview } from "../shared/schema.js";

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

export interface ReviewTraceEvent {
	readonly content: string;
	readonly surface: ReviewTraceSurface;
	readonly passKind: ReviewTracePassKind;
	readonly passIndex: number;
	readonly promptAttempt: number;
	readonly runnerAttempt: number;
	readonly outcome: ReviewTraceOutcome;
}

export type ReviewTraceObserver = (event: ReviewTraceEvent) => void;

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

export function observeReviewTrace(
	observer: ReviewTraceObserver | undefined,
	event: ReviewTraceEvent,
): void {
	observer?.(event);
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
