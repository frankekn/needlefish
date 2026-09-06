import assert from "node:assert/strict";
import test from "node:test";
import {
	observeCandidateReviewTrace,
	observeFinalReviewTrace,
	observeMapCandidateTrace,
	observeReviewTrace,
	type ReviewTraceEvent,
	type ReviewTraceProvenance,
} from "./review-trace.js";
import type { RawReview } from "../shared/schema.js";

test("candidate, map, and final traces copy only declared provenance fields", async () => {
	const review: RawReview = {
		summary: "candidate",
		findings: [{
			category: "bug", severity: "P2", confidence: 0.9,
			file: "src/app.ts", lineStart: 1, lineEnd: 1,
			title: "bug", whyItBreaks: "breaks", suggestedFix: "fix", validation: "test",
		}],
		checked: ["checked"],
		residual_risks: [],
	};
	const provenance: ReviewTraceProvenance = {
		passKind: "review", passIndex: 2, promptAttempt: 3, runnerAttempt: 4,
	};
	// review() passes PromptResult objects, whose extra value is mutable.
	const result = { value: review, ...provenance };
	const events: ReviewTraceEvent[] = [];
	const observer = (event: ReviewTraceEvent): void => { events.push(event); };
	await observeCandidateReviewTrace({ observer, review, provenance: result });
	const mapResult = { summary: "map", hotspots: [] };
	const mapPromptResult = { value: mapResult, ...provenance };
	await observeMapCandidateTrace({
		observer, mapResult, provenance: mapPromptResult,
	});
	await observeFinalReviewTrace({ observer, review, summary: "final", provenance: result });
	assert.deepEqual(events.map((event) => event.surface), [
		"candidate_finding", "candidate_review_text", "candidate_review_text",
		"final_finding", "final_review_text",
	]);
	const text = { checked: review.checked, residual_risks: [] };
	assert.deepEqual(events.map((event) => event.content), [
		JSON.stringify(review.findings[0]),
		JSON.stringify({ summary: "candidate", ...text }),
		JSON.stringify(mapResult),
		JSON.stringify(review.findings[0]),
		JSON.stringify({ summary: "final", ...text }),
	]);
	for (const event of events) {
		assert.deepEqual(Object.keys(event), [
			"content", "surface", ...(event.finding ? ["finding"] : []), "outcome",
			"passKind", "passIndex", "promptAttempt", "runnerAttempt",
		]);
		assert.equal(Object.isFrozen(event), true);
		assert.equal(event.outcome, "parsed");
		assert.deepEqual({
			passKind: event.passKind, passIndex: event.passIndex,
			promptAttempt: event.promptAttempt, runnerAttempt: event.runnerAttempt,
		}, provenance);
		if (event.finding) {
			assert.equal(Object.isFrozen(event.finding), true);
			assert.notEqual(event.finding, review.findings[0]);
		}
	}
});

test("observeReviewTrace propagates asynchronous observer rejection", async () => {
	const rejection = new Error("trace delivery failed");

	await assert.rejects(
		async () => await observeReviewTrace(
			async () => {
				await Promise.resolve();
				throw rejection;
			},
			{
				content: "raw output",
				surface: "raw_success",
				passKind: "review",
				passIndex: 0,
				promptAttempt: 1,
				runnerAttempt: 1,
				outcome: "parsed",
			},
		),
		rejection,
	);
});
