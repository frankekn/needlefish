import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// GitHub Actions interpolates ${{ }} into the run script before bash parses it.
// Double quotes do not stop command substitution: $(...) and backticks in a
// substituted value become program text and execute. That is the exploitable
// class. Passing the PR number through env: and expanding "$PR_NUM" keeps the
// value out of the script, which is the structural fix. The integer check is a
// second gate, not a reason to put ${{ }} back into the run block.

const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const step = workflow.match(
	/      - name: Needlefish review\n([\s\S]*?)(?=\n      - name:|$)/,
);
assert.ok(step, "Needlefish review step must exist");
const runBlock = step[1].match(/        run: \|\n([\s\S]*)/);
assert.ok(runBlock, "Needlefish review must have a run block");
const script = runBlock[1]
	.split("\n")
	.map((line) => line.replace(/^          /, ""))
	.join("\n");

function runReview(prNum) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-workflow-pr-"));
	const fakeBin = join(root, "fake bin");
	const argvLog = join(root, "argv.log");
	const needlefishBin = join(fakeBin, "needlefish");
	mkdirSync(fakeBin);
	writeFileSync(
		needlefishBin,
		`#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do printf '<%s>\\n' "$arg" >> "$ARGV_LOG"; done
`,
	);
	chmodSync(needlefishBin, 0o755);

	const result = spawnSync("bash", ["-c", script], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			ARGV_LOG: argvLog,
			CODEX_REASONING_EFFORT: "",
			NEEDLEFISH_BIN: needlefishBin,
			NEEDLEFISH_MODEL_INPUT: "",
			NEEDLEFISH_RECHECK_INPUT: "",
			NEEDLEFISH_RUNNER_INPUT: "",
			NEEDLEFISH_TIMEOUT_MS_INPUT: "",
			OPENCODE_IDLE_TIMEOUT_MS_INPUT: "",
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			PR_NUM: prNum,
		},
	});
	const output = {
		...result,
		argvLog: existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
		pwned: existsSync(join(root, "pwned")),
	};
	rmSync(root, { recursive: true, force: true });
	return output;
}

test("review resolves the PR number through env and quoted expansion", () => {
	assert.match(
		step[1],
		/PR_NUM: \$\{\{ inputs\.pr_number \|\| github\.event\.inputs\.pr_number \|\| github\.event\.pull_request\.number \}\}/,
	);
	assert.match(script, /args=\(--github --pr "\$PR_NUM"\)/);
	assert.match(script, /"\$NEEDLEFISH_BIN" "\$\{args\[@\]\}"/);
	assert.doesNotMatch(script, /\$\{\{/);
});

test("review invokes needlefish with a valid numeric PR number", () => {
	const result = runReview("42");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.argvLog, /<--github>\n<--pr>\n<42>\n/);
});

test("review rejects PR number 0 before invoking needlefish", () => {
	const result = runReview("0");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects PR number -1 before invoking needlefish", () => {
	const result = runReview("-1");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects PR number abc before invoking needlefish", () => {
	const result = runReview("abc");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects a trailing-command PR number before invoking needlefish", () => {
	const result = runReview("1; touch pwned");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects an empty PR number before invoking needlefish", () => {
	const result = runReview("");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects command substitution $(touch pwned) before invoking needlefish", () => {
	const result = runReview("$(touch pwned)");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects backtick command substitution before invoking needlefish", () => {
	const result = runReview("`touch pwned`");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects command substitution appended to a numeric PR number before invoking needlefish", () => {
	const result = runReview("1$(touch pwned)");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects a quote-breaking PR number before invoking needlefish", () => {
	const result = runReview(`1" ; touch pwned ; "`);

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});
