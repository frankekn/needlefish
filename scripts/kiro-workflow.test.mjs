import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const review = readFileSync(".github/workflows/review.yml", "utf8");
const weekly = readFileSync(".github/workflows/weekly-eval.yml", "utf8");
const action = readFileSync("action.yml", "utf8");

test("self-hosted review defaults to guarded Kiro Luna xhigh", () => {
	assert.equal((review.match(/default: kiro/g) ?? []).length, 2);
	assert.equal(
		(review.match(/description: Optional reasoning effort for the selected runner/g) ?? []).length,
		2,
	);
	assert.match(review, /NEEDLEFISH_RUNNER_INPUT:.*'kiro'/);
	assert.match(review, /KIRO_API_KEY:.*secrets\.KIRO_API_KEY/);
	assert.match(review, /kiro\) NEEDLEFISH_MODEL_INPUT="gpt-5\.6-luna"/);
	assert.match(review, /NEEDLEFISH_EFFORT_INPUT="xhigh"/);
	assert.match(review, /args\+=\(--effort "\$NEEDLEFISH_EFFORT_INPUT"\)/);
	assert.match(review, /export NEEDLEFISH_EPHEMERAL_HOME=1/);
	assert.match(review, /if \[ -z "\$\{KIRO_API_KEY:-\}" \]; then/);
	assert.match(
		review,
		/export NEEDLEFISH_KIRO_AUTH_DB="\$HOME\/\.config\/needlefish\/kiro-auth\.sqlite3"/,
	);
	assert.doesNotMatch(review, /unset KIRO_API_KEY/);
	assert.match(review, /CODEX_REASONING_EFFORT:.*codex_reasoning_effort/);
});

test("weekly eval mirrors the guarded production Kiro lane", () => {
	assert.match(weekly, /NEEDLEFISH_EPHEMERAL_HOME: "1"/);
	assert.match(weekly, /KIRO_API_KEY:.*secrets\.KIRO_API_KEY/);
	assert.match(weekly, /if \[ -z "\$\{KIRO_API_KEY:-\}" \]; then/);
	assert.match(
		weekly,
		/export NEEDLEFISH_KIRO_AUTH_DB="\$HOME\/\.config\/needlefish\/kiro-auth\.sqlite3"/,
	);
	assert.doesNotMatch(weekly, /unset KIRO_API_KEY/);
	assert.match(
		weekly,
		/--runner kiro --model gpt-5\.6-luna --effort xhigh --draws 3/,
	);
	assert.doesNotMatch(weekly, /--runner codex --model gpt-5\.6-sol/);
});

test("hosted action passes generic effort without adding Kiro installation", () => {
	assert.match(action, /^ {2}effort:\n {4}description: Optional reasoning effort/m);
	assert.match(action, /EFFORT_INPUT: \$\{\{ inputs\.effort \}\}/);
	assert.match(action, /args\+=\(--effort "\$EFFORT_INPUT"\)/);
	assert.doesNotMatch(action, /kiro\) pkg=/);
	assert.doesNotMatch(action, /KIRO_AUTH|KIRO_API_KEY|KIRO_BIN/);
});
