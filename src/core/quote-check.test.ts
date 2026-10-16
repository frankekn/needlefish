import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	writeFileSync(path.join(repo, "src", "app.ts"), "const removedLine = legacyCall();\nconst retained = stableCall();\n");
	writeFileSync(path.join(repo, "src", "lib.ts"), "export const untouched = stableValue();\n");
	commitAll(repo, "base");
	const baseSha = headSha(repo);
	gitText(["checkout", "-b", "feature"], repo);
	writeFileSync(path.join(repo, "src", "app.ts"), "// header\nconst total = price * quantity;\nconst retained = stableCall();\n");
	writeFileSync(path.join(repo, "src", "other.ts"), "// header\n\nconst unique = onlyInOther();\n");
	commitAll(repo, "feature");
	return {
		repoPath: repo,
		baseSha,
		headSha: headSha(repo),
		patch: gitText(["diff", baseSha, "HEAD"], repo),
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


test("checkQuotes relocates a later quote in a broad range instead of retaining its replacement", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 1, lineEnd: 2, quote: "const total = price * quantity;" }], bundle);
	assert.deepEqual(finding.quoteCheck, { status: "moved", from: "src/app.ts:1" });
	assert.equal(finding.lineStart, 2);
	assert.equal(finding.lineEnd, 2);
	assert.equal(finding.replacement, undefined);
});

test("checkQuotes rejects a base quote after lineStart in a broad range", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 1, lineEnd: 2, quote: "const retained = stableCall();" }], bundle);
	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.lineStart, 1);
	assert.equal(finding.lineEnd, 2);
	assert.equal(finding.replacement, undefined);
});

test("checkQuotes does not relocate onto unchanged context in a changed file", (t) => {
	const bundle = makeRepo(t);
	const [finding] = checkQuotes([{ ...FINDING, file: "src/other.ts", lineStart: 7, lineEnd: 9, quote: "const retained = stableCall();" }], bundle);
	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.file, "src/other.ts");
	assert.equal(finding.lineStart, 7);
	assert.equal(finding.replacement, undefined);
});


test("checkQuotes does not relocate onto the unchanged line after a deletion", (t) => {
	const bundle = makeRepo(t);
	writeFileSync(path.join(bundle.repoPath, "src", "app.ts"), "const retained = stableCall();\n");
	commitAll(bundle.repoPath, "only deletion");
	const [finding] = checkQuotes([{ ...FINDING, file: "src/other.ts", quote: "const retained = stableCall();" }], { ...bundle, headSha: headSha(bundle.repoPath) });
	assert.deepEqual(finding.quoteCheck, { status: "not_found" });
	assert.equal(finding.file, "src/other.ts");
	assert.equal(finding.replacement, undefined);
});


test("checkQuotes distinguishes retained and added lines across a quoted-path rename", (t) => {
	const bundle = makeRepo(t);
	const renamed = 'src/new ["名"].ts';
	gitText(["mv", "src/lib.ts", renamed], bundle.repoPath);
	writeFileSync(path.join(bundle.repoPath, renamed), "export const untouched = stableValue();\nconst renamedAdded = freshCall();\n");
	commitAll(bundle.repoPath, "rename and add");
	const head: Bundle = { ...bundle, headSha: headSha(bundle.repoPath), changedFiles: [...bundle.changedFiles, { path: renamed, surface: "source" }] };
	const [unchanged, added] = checkQuotes([
		{ ...FINDING, quote: "export const untouched = stableValue();" },
		{ ...FINDING, quote: "const renamedAdded = freshCall();" },
	], head);
	assert.deepEqual(unchanged.quoteCheck, { status: "not_found" });
	assert.equal(unchanged.file, "src/app.ts");
	assert.deepEqual(added.quoteCheck, { status: "moved", from: "src/app.ts:1" });
	assert.equal(added.file, renamed);
	assert.equal(added.lineStart, 2);
	assert.equal(added.replacement, undefined);
});


test("checkQuotes never resolves a WORKING branch as the uncommitted sentinel", (t) => {
	const bundle = makeRepo(t);
	gitText(["branch", "WORKING", bundle.headSha], bundle.repoPath);
	const quoted = { ...FINDING, lineStart: 2, lineEnd: 2, quote: "const total = price * quantity;" };
	const [finding] = checkQuotes([quoted], { ...bundle, headSha: "WORKING" });
	assert.deepEqual(finding, { ...quoted, replacement: undefined, quoteCheck: { status: "unchecked" } });
});

test("checkQuotes matches a removed base line across a quoted-path rename", (t) => {
	const bundle = makeRepo(t);
	const renamed = 'src/new ["名"].ts';
	const retained = Array.from({ length: 10 }, (_, index) => `const retained${index} = stableCall();`).join("\n") + "\n";
	writeFileSync(path.join(bundle.repoPath, "src/app.ts"), "const removedLine = legacyCall();\n" + retained);
	commitAll(bundle.repoPath, "base before rename");
	const baseSha = headSha(bundle.repoPath);
	gitText(["mv", "src/app.ts", renamed], bundle.repoPath);
	writeFileSync(path.join(bundle.repoPath, renamed), retained);
	commitAll(bundle.repoPath, "rename after removing source");
	const [finding] = checkQuotes([{ ...FINDING, file: renamed, quote: "const removedLine = legacyCall();" }], {
		...bundle,
		baseSha,
		headSha: headSha(bundle.repoPath),
		changedFiles: [{ path: renamed, surface: "source" }],
	});
	assert.deepEqual(finding.quoteCheck, { status: "matched" });
	assert.equal(finding.file, renamed);
	assert.equal(finding.lineStart, 1);
	assert.equal(finding.replacement, undefined);
});

for (const command of ["grep", "diff"]) {
	test(`checkQuotes shares its remaining deadline across findings and caps ${command}`, (t) => {
		const bundle = makeRepo(t);
		const bin = path.join(bundle.repoPath, "bin");
		mkdirSync(bin);
		const calls = path.join(bin, "calls");
		const budgetMs = command === "grep" ? 300 : 1000;
		const originalPath = process.env.PATH;
		const realGit = gitText(["--exec-path"], bundle.repoPath).trim() + "/git";
		const shim = path.join(bin, "git");
		writeFileSync(shim, [
			`#!${process.execPath}`,
			"const fs = require('node:fs');",
			"const { spawnSync } = require('node:child_process');",
			`const command = ${JSON.stringify(command)};`,
			"const args = process.argv.slice(2);",
			"if (args.includes(command)) {",
			`  fs.appendFileSync(${JSON.stringify(calls)}, ${JSON.stringify(command + "\n")});`,
			`  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${budgetMs + 300});`,
			"}",
			`const result = spawnSync(${JSON.stringify(realGit)}, args, { encoding: 'utf8' });`,
			"process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');",
			"process.exit(result.status ?? 2);",
		].join("\n"));
		chmodSync(shim, 0o755);
		t.after(() => {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		});
		process.env.PATH = bin + path.delimiter + originalPath;
		const startedAt = performance.now();
		const quoted = { ...FINDING, quote: "const unique = onlyInOther();" };
		const findings = checkQuotes([quoted, quoted, quoted], bundle, startedAt + budgetMs);
		assert.deepEqual(findings.map((finding) => finding.quoteCheck), Array(3).fill({ status: "unchecked" }));
		assert.ok(findings.every((finding) => finding.replacement === undefined));
		assert.ok(performance.now() - startedAt < budgetMs + 600, "quote checks exceeded one shared budget");
		assert.equal(readFileSync(calls, "utf8"), command + "\n");
	});
}
