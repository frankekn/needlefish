import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

	assert.deepEqual({ ...finding, evidence: undefined }, { ...input, evidence: undefined, replacement: undefined, quoteCheck: { status: "not_found" } });
});

test("checkQuotes marks short and uncheckable quotes unchecked, and preserves absent quotes", (t) => {
	const bundle = makeRepo(t);
	const short = { ...FINDING, quote: "x = 1;" };
	const quoted = { ...FINDING, quote: "this line does not exist anywhere" };

	const [shortResult, absent] = checkQuotes([short, FINDING], bundle);
	assert.deepEqual(shortResult.quoteCheck, { status: "unchecked" });
	assert.equal(shortResult.replacement, undefined);
	assert.equal(absent.title, "Bug");
	assert.equal(absent.quoteCheck, undefined);
	assert.equal(absent.replacement, undefined);
	// Uncommitted mode reviews the WORKING sentinel, which is not a git ref.
	assert.deepEqual(checkQuotes([quoted], { ...bundle, headSha: "WORKING" })[0].quoteCheck, { status: "unchecked" });
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

	assert.deepEqual(checkQuotes([quoted], bundle)[0].quoteCheck, { status: "unchecked" });
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


test("source evidence uses the captured blob and program digest, never the working file or model claims", (t) => {
	const bundle = makeRepo(t);
	writeFileSync(path.join(bundle.repoPath, "src/app.ts"), "private working content\n");
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 2, lineEnd: 2, quote: "const total = price * quantity;" }], bundle);
	assert.deepEqual(finding.evidence, { toolRead: "unknown", sources: [{ sourceType: "git_blob",
		revision: bundle.headSha, file: "src/app.ts", lineStart: 2, lineEnd: 2, status: "source_present",
		contentDigest: "240f5c20ee6eac7d8c3793d3efdce8a5cd5cfc87ade28b8a2d0ac1a2b6c2db9e" }] });
});

test("source evidence records base revision for removed code and no digest for invalid revisions", (t) => {
	const bundle = makeRepo(t);
	const [removed] = checkQuotes([{ ...FINDING, quote: "const removedLine = legacyCall();" }], bundle);
	const source = removed.evidence?.sources[0];
	assert.equal(source?.sourceType === "git_blob" ? source.revision : undefined, bundle.baseSha);
	for (const headSha of ["WORKING", "HEAD", "0".repeat(40)]) {
		const [finding] = checkQuotes([{ ...FINDING, quote: "const removedLine = legacyCall();" }], { ...bundle, headSha });
		assert.deepEqual(finding.evidence, { toolRead: "unknown", sources: [{ sourceType: "git_blob",
			revision: headSha.length === 40 ? headSha : null, file: "src/app.ts", lineStart: 1, lineEnd: 1, status: "source_unverified" }] });
	}
});

test("source evidence rejects escapes and symlinks without reading their targets", (t) => {
	const bundle = makeRepo(t);
	const secret = path.join(path.dirname(bundle.repoPath), "private.txt");
	writeFileSync(secret, "private-value-that-must-not-appear\n");
	t.after(() => rmSync(secret, { force: true }));
	symlinkSync(secret, path.join(bundle.repoPath, "link.ts"));
	commitAll(bundle.repoPath, "symlink");
	const head = { ...bundle, headSha: headSha(bundle.repoPath) };
	for (const file of [secret, "../private.txt", "src/../src/app.ts", "C:\\private.txt", "link.ts", "link.ts/private.txt"]) {
		const [finding] = checkQuotes([{ ...FINDING, file, quote: "private-value-that-must-not-appear" }], head);
		assert.equal(finding.evidence?.sources[0].status, "source_unverified", file);
		assert.equal(JSON.stringify(finding.evidence).includes("contentDigest"), false);
	}
});

test("source evidence keeps code and declares every external URL unverified", (t) => {
	const bundle = makeRepo(t);
	const claim = { claim: "Vendor permits a fictional prefix", necessary: false,
		source: { type: "external", url: "https://spec.example.invalid/reference" } } satisfies NonNullable<Finding["externalClaims"]>[number];
	const [finding] = checkQuotes([{ ...FINDING, lineStart: 2, lineEnd: 2, quote: "const total = price * quantity;", externalClaims: [claim] }], bundle);
	assert.equal(finding.evidence?.sources[0].status, "source_present");
	assert.deepEqual(finding.evidence?.sources[1], { ...claim, sourceType: "external", status: "unverified_external_claim" });
});

test("source evidence leaves wrong ranges and mismatched quotes unverified", (t) => {
	const bundle = makeRepo(t);
	for (const finding of [
		{ ...FINDING, lineStart: 1.5, lineEnd: 2, quote: "const total = price * quantity;" },
		{ ...FINDING, lineStart: 3, lineEnd: 999, quote: "const retained = stableCall();" },
		{ ...FINDING, quote: "fabricated full source line" },
	]) {
		const [checked] = checkQuotes([finding], bundle);
		assert.equal(checked.evidence?.sources[0].status, "source_unverified");
	}
});


test("source evidence ignores blob and commit replacement refs", (t) => {
	const bundle = makeRepo(t);
	const replacementFile = path.join(bundle.repoPath, "replacement.txt");
	writeFileSync(replacementFile, "const substituted = replacementContent();\n");
	const originalBlob = gitText(["rev-parse", `${bundle.headSha}:src/app.ts`], bundle.repoPath);
	const replacedBlob = gitText(["hash-object", "-w", replacementFile], bundle.repoPath);
	gitText(["replace", originalBlob, replacedBlob], bundle.repoPath);
	const quoted = { ...FINDING, lineStart: 2, lineEnd: 2, quote: "const total = price * quantity;" };
	const [original] = checkQuotes([quoted], bundle);
	assert.equal(original.evidence?.sources[0].status, "source_present");
	const [substituted] = checkQuotes([{ ...FINDING, quote: "const substituted = replacementContent();" }], bundle);
	assert.equal(substituted.evidence?.sources[0].status, "source_unverified");
	gitText(["replace", bundle.headSha, bundle.baseSha], bundle.repoPath);
	const [captured] = checkQuotes([quoted], bundle);
	assert.deepEqual(captured.evidence, original.evidence);
	assert.deepEqual(captured.quoteCheck, { status: "matched" });
});

test("checkQuotes never resolves a WORKING branch as the uncommitted sentinel", (t) => {
	const bundle = makeRepo(t);
	gitText(["branch", "WORKING", bundle.headSha], bundle.repoPath);
	const quoted = { ...FINDING, lineStart: 2, lineEnd: 2, quote: "const total = price * quantity;" };
	const [finding] = checkQuotes([quoted], { ...bundle, headSha: "WORKING" });
	assert.deepEqual(finding.quoteCheck, { status: "unchecked" });
	assert.equal(finding.replacement, undefined);
	assert.equal(finding.evidence?.sources[0].status, "source_unverified");
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
	const source = finding.evidence?.sources[0];
	assert.equal(source?.sourceType, "git_blob");
	assert.equal(source?.status, "source_present");
	assert.equal(source?.sourceType === "git_blob" ? source.file : undefined, "src/app.ts");
	assert.equal(source?.sourceType === "git_blob" ? source.revision : undefined, baseSha);
});

for (const command of ["ls-tree", "cat-file", "grep", "diff"]) {
	test(`checkQuotes shares its remaining deadline across findings and caps the first ${command} subprocess`, (t) => {
		const bundle = makeRepo(t);
		const bin = path.join(bundle.repoPath, "bin");
		mkdirSync(bin);
		const calls = path.join(bin, "calls");
		const budgetMs = 1000;
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
			`  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${budgetMs + 5_000});`,
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


test("checkQuotes rejects option-shaped base revisions before Git can write files", (t) => {
	const bundle = makeRepo(t);
	const destination = path.join(bundle.repoPath, "must-survive.txt");
	writeFileSync(destination, "preserve this file\n");
	const [finding] = checkQuotes([{ ...FINDING, quote: "this quoted source does not exist" }], {
		...bundle, baseSha: `--output=${destination}`,
	});
	assert.deepEqual(finding.quoteCheck, { status: "unchecked" });
	assert.equal(finding.evidence?.sources[0].status, "source_unverified");
	assert.equal(finding.replacement, undefined);
	assert.equal(readFileSync(destination, "utf8"), "preserve this file\n");
});
