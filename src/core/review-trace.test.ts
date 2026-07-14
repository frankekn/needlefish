import assert from "node:assert/strict";
import test from "node:test";
import { observeReviewTrace } from "./review-trace.js";

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
