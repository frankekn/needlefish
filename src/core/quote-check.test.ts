import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { checkQuotes } from "./quote-check";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import type { Bundle, Finding } from "../shared/schema";

const FINDING: Finding = {
	severity: "P2",
	title: "Bug",
	category: "bug",
	file: "src/app.ts",
	lineStart: 1,
	lineEnd: 1,
	confidence: 0.9,
	whyItBreaks: "breaks",
	suggestedFix: "fix",
	validation: "test",
	replacement: { lines: ["fixed();"] },
};

// base: src/app.ts holds a line the feature removes; src/lib.ts is unchanged.
// head: src/app.ts and src/other.ts each gain one distinct line.
function makeRepo(t: TestContext): Bundle {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-quote-check-test-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const repo = initRepo(tmp);
	mkdirSync(path.join(repo, "src"));
	writeFileSync(path.join(repo, "src", "app.ts"), "const removedLine = legacyCall();\n");
	writeFileSync(path.join(repo, "src", "lib.ts"), "export const untouched = stableValue();\n");
	commitAll(repo, "base");
	const baseSha = headSha(repo);
	gitText(["checkout", "-b", "feature"], repo);
	writeFileSync(path.join(repo, "src", "app.ts"), "// header\nconst total = price * quantity;\n");
	writeFileSync(path.join(repo, "src", "other.ts"), "// header\n\nconst unique = onlyInOther();\n");
	commitAll(repo, "feature");
	return {
		repoPath: repo,
		baseSha,
		headSha: headSha(repo),
		patch: "",
		patchStat: "",
		changedFiles: [
			{ path: "src/app.ts", surface: "source" },
			{ path: "src/other.ts", surface: "source" },
		],
		agentsMd: "",
		prMeta: null,
		deep: false,
		focus: null,
	};
}

test("checkQuotes marks a quote found in the cited file at head as matched", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 2, lineEnd: 2, quote: "const total = price * quantity;" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "matched" });
	assert.equal(finding.lineStart, 2);
	assert.deepEqual(finding.replacement, FINDING.replacement);
});

test("checkQuotes matches a removed line against the cited file at base", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, quote: "const removedLine = legacyCall();" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "matched" });
	assert.equal(finding.file, "src/app.ts");
});

test("checkQuotes moves a finding to the one changed line that holds its quote", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 7, lineEnd: 9, quote: "const unique = onlyInOther();" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "moved", from: "src/app.ts:7" });
	assert.equal(finding.file, "src/other.ts");
	assert.equal(finding.lineStart, 3);
	assert.equal(finding.lineEnd, 3);
	assert.equal(finding.replacement, undefined);
	assert.equal(finding.severity, "P2");
});

test("checkQuotes does not move a finding onto an unchanged file", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, quote: "export const untouched = stableValue();" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.file, "src/app.ts");
});

test("checkQuotes does not move a finding when the quote has several hits", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, file: "src/lib.ts", quote: "// header" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.file, "src/lib.ts");
});

test("checkQuotes marks a quote found nowhere as not_found and keeps the finding", (t) => {
	const bundle = makeRepo(t);
	const input = { ...FINDING, quote: "this line does not exist anywhere" };
	const [finding] = checkQuotes([input], bundle);

	assert.deepEqual(finding, { ...input, quoteCheck: { status: "not_found" } });
});

test("checkQuotes leaves short, absent, and uncheckable quotes unchanged", (t) => {
	const bundle = makeRepo(t);
	const short = { ...FINDING, quote: "x = 1;" };
	const quoted = { ...FINDING, quote: "this line does not exist anywhere" };

	assert.deepEqual(checkQuotes([short, FINDING], bundle), [short, FINDING]);
	// Uncommitted mode reviews the WORKING sentinel, which is not a git ref.
	assert.deepEqual(checkQuotes([quoted], { ...bundle, headSha: "WORKING" }), [quoted]);
});

test("checkQuotes treats the cited file as a literal path, not a glob", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, file: "src/*.ts", quote: "const removedLine = legacyCall();" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
});
