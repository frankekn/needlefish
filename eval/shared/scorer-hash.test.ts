import { test } from "node:test";
import assert from "node:assert/strict";
import { scorerHash } from "./scorer-hash";

test("scorerHash: unchanged, so existing reports stay comparable", () => {
	assert.equal(
		scorerHash(),
		"8bbc6152d8b45a43",
		"score.ts, robustness.ts, or types.ts changed: every existing report is orphaned from --compare/--resume. Update this pin only for a deliberate re-baseline.",
	);
});
