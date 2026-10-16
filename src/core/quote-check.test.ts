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
	assert.equal(finding.replacement, undefined);
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

	assert.deepEqual(finding, { ...input, replacement: undefined, quoteCheck: { status: "not_found" } });
});

test("checkQuotes marks short and uncheckable quotes unchecked, and preserves absent quotes", (t) => {
	const bundle = makeRepo(t);
	const short = { ...FINDING, quote: "x = 1;" };
	const quoted = { ...FINDING, quote: "this line does not exist anywhere" };

	assert.deepEqual(checkQuotes([short, FINDING], bundle), [{ ...short, replacement: undefined, quoteCheck: { status: "unchecked" } }, FINDING]);
	// Uncommitted mode reviews the WORKING sentinel, which is not a git ref.
	assert.deepEqual(checkQuotes([quoted], { ...bundle, headSha: "WORKING" }), [{ ...quoted, replacement: undefined, quoteCheck: { status: "unchecked" } }]);
});

test("checkQuotes treats the cited file as a literal path, not a glob", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, file: "src/*.ts", quote: "const removedLine = legacyCall();" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
});

test("checkQuotes does not move a finding onto a line that only mentions the quote", (t) => {
	const bundle = makeRepo(t);
	// "onlyInOther();" appears once at head, inside the longer line in src/other.ts.
	const [finding] = checkQuotes([{ ...FINDING, quote: "onlyInOther();" }], bundle);

	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.file, "src/app.ts");
});

test("checkQuotes leaves a finding unchecked when the quote or file holds a NUL", (t) => {
	const bundle = makeRepo(t);
	const quoted = { ...FINDING, quote: "const total = price * quantity;\0" };
	const filed = { ...FINDING, file: "src/app.ts\0", quote: "const removedLine = legacyCall();" };

	assert.deepEqual(checkQuotes([quoted], bundle), [{ ...quoted, replacement: undefined, quoteCheck: { status: "unchecked" } }]);
	assert.deepEqual(checkQuotes([filed], bundle)[0].quoteCheck, { status: "unchecked" });
});


test("checkQuotes relocates a whole quote on the wrong line in the cited file and suppresses its replacement", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, quote: "const total = price * quantity;" }], bundle);
	assert.deepEqual(finding.quoteCheck, { status: "moved", from: "src/app.ts:1" });
	assert.equal(finding.lineStart, 2);
	assert.equal(finding.replacement, undefined);
});

test("checkQuotes rejects a substring in the cited file and suppresses its replacement", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 2, lineEnd: 2, quote: "total = price * quantity;" }], bundle);
	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.replacement, undefined);
});

test("checkQuotes warns on an invalid head or base and suppresses replacements", (t) => {
	const bundle = makeRepo(t);
	const quoted = { ...FINDING, quote: "this line does not exist anywhere" };
	for (const invalid of [{ ...bundle, headSha: "invalid-ref" }, { ...bundle, baseSha: "invalid-ref" }]) {
		const [finding] = checkQuotes([quoted], invalid);
		assert.deepEqual(finding.quoteCheck, { status: "unchecked" });
		assert.equal(finding.replacement, undefined);
	}
});

test("checkQuotes verifies a cited line before an overflowing whole-tree search", (t) => {
	const bundle = makeRepo(t);
	const quote = "const total = price * quantity;";
	writeFileSync(path.join(bundle.repoPath, "many.ts"), (quote + "\n").repeat(500_000));
	commitAll(bundle.repoPath, "many matches");
	const head = { ...bundle, headSha: headSha(bundle.repoPath) };
	const [matched] = checkQuotes([{ ...FINDING, lineStart: 2, lineEnd: 2, quote }], head);
	assert.deepEqual(matched.quoteCheck, { status: "matched" });
	assert.deepEqual(matched.replacement, FINDING.replacement);
	const [unchecked] = checkQuotes([{ ...FINDING, file: "absent.ts", quote }], head);
	assert.deepEqual(unchecked.quoteCheck, { status: "unchecked" });
	assert.equal(unchecked.replacement, undefined);
});
