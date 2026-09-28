import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

// A literal NUL makes grep and rg treat the whole file as binary, so reviewers
// and model runners searching it get "binary file matches" instead of lines.
// Write "\u0000" in source instead.
const TEXT = /\.(?:[cm]?[jt]s|json|md|ya?ml|sh)$/;

test("no tracked text source contains a literal NUL byte", () => {
	const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
		.split("\0")
		.filter((file) => TEXT.test(file));
	assert.ok(files.length > 100, "git ls-files returned the tracked tree");
	const offenders = files.filter((file) => readFileSync(file).includes(0));
	assert.deepEqual(offenders, []);
});
