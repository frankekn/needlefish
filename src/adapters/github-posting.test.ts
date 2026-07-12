import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
	commitAll,
	gitText,
	headSha,
	initRepo,
} from "../shared/codex-runner-test-fixtures";
import {
	renderState,
	parseState,
	matchFindings,
	type FindingKey,
	runGithub,
} from "./github";
import type { Finding } from "../shared/schema";

type Post = {
	readonly args: readonly string[];
	readonly payload: string;
};

type Fixture = {
	readonly postLog: string;
	readonly repo: string;
	readonly reviewOutput: string;
	readonly reviewsState: string;
};

type FixtureOptions = {
	readonly prNumber: number;
	readonly rawReview: string;
	readonly staleHeadAfterReview?: boolean;
};

function isPost(raw: unknown): raw is Post {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw))
		return false;
	const args = Reflect.get(raw, "args");
	const payload = Reflect.get(raw, "payload");
	return (
		Array.isArray(args) &&
		args.every((item) => typeof item === "string") &&
		typeof payload === "string"
	);
}

function parseJson(input: string): unknown {
	try {
		return JSON.parse(input);
	} catch (error) {
		throw new Error("expected valid test JSON", { cause: error });
	}
}

function readPosts(file: string): readonly Post[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const raw = parseJson(line);
			if (!isPost(raw)) throw new Error("expected post log entry");
			return raw;
		});
}

type ReviewPayload = {
	readonly commit_id: string;
	readonly body: string;
	readonly event: string;
	readonly comments: readonly Record<string, unknown>[];
};

function parseReviewPayload(payload: string): ReviewPayload {
	const raw = parseJson(payload);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("expected review payload object");
	}
	const record = raw as Record<string, unknown>;
	const comments = Array.isArray(record.comments)
		? (record.comments as Record<string, unknown>[])
		: [];
	return {
		commit_id: typeof record.commit_id === "string" ? record.commit_id : "",
		body: typeof record.body === "string" ? record.body : "",
		event: typeof record.event === "string" ? record.event : "",
		comments,
	};
}

function mkFinding(overrides: Partial<Finding> = {}): Finding {
	return {
		severity: "P2",
		title: "bug",
		category: "bug",
		file: "README.md",
		lineStart: 1,
		lineEnd: 1,
		confidence: 0.9,
		whyItBreaks: "breaks",
		suggestedFix: "fix",
		validation: "test",
		...overrides,
	};
}

function setupFixture(t: TestContext, opts: FixtureOptions): Fixture {
	const tmp = mkdtempSync(
		path.join(os.tmpdir(), "needlefish-github-posting-test-"),
	);
	const repo = initRepo(tmp);
	const fakeBin = path.join(tmp, "bin");
	const gh = path.join(fakeBin, "gh");
	const claude = path.join(fakeBin, "claude");
	const postLog = path.join(tmp, "posts.jsonl");
	const reviewsState = path.join(tmp, "reviews-state.json");
	const issueCommentsState = path.join(tmp, "issue-comments-state.json");
	const previous = {
		path: process.env.PATH,
		repository: process.env.GITHUB_REPOSITORY,
		head: process.env.PR_HEAD_SHA,
		base: process.env.PR_BASE_SHA,
		runner: process.env.NEEDLEFISH_RUNNER,
		claude: process.env.CLAUDE_BIN,
		noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
		exitCode: process.exitCode,
	};
	t.after(() => {
		if (previous.path === undefined) delete process.env.PATH;
		else process.env.PATH = previous.path;
		if (previous.repository === undefined) delete process.env.GITHUB_REPOSITORY;
		else process.env.GITHUB_REPOSITORY = previous.repository;
		if (previous.head === undefined) delete process.env.PR_HEAD_SHA;
		else process.env.PR_HEAD_SHA = previous.head;
		if (previous.base === undefined) delete process.env.PR_BASE_SHA;
		else process.env.PR_BASE_SHA = previous.base;
		if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
		else process.env.NEEDLEFISH_RUNNER = previous.runner;
		if (previous.claude === undefined) delete process.env.CLAUDE_BIN;
		else process.env.CLAUDE_BIN = previous.claude;
		if (previous.noFastPath === undefined)
			delete process.env.NEEDLEFISH_NO_FAST_PATH;
		else process.env.NEEDLEFISH_NO_FAST_PATH = previous.noFastPath;
		process.exitCode = previous.exitCode;
		rmSync(tmp, { recursive: true, force: true });
	});

	gitText(["branch", "-M", "main"], repo);
	const baseSha = headSha(repo);
	gitText(["checkout", "-b", "feature"], repo);
	writeFileSync(path.join(repo, "README.md"), "feature\n");
	commitAll(repo, "feature");
	const targetHeadSha = headSha(repo);
	let latestHeadSha = targetHeadSha;
	if (opts.staleHeadAfterReview === true) {
		writeFileSync(path.join(repo, "README.md"), "newer feature\n");
		commitAll(repo, "newer feature");
		latestHeadSha = headSha(repo);
	}

	mkdirSync(fakeBin);
	const countPath = path.join(tmp, "pull-count");
	writeFileSync(
		gh,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			"const args = process.argv.slice(2);",
			"if (args[0] !== 'api') process.exit(2);",
			"if (args.includes('--input')) {",
			"  const payload = fs.readFileSync(0, 'utf8');",
			`  fs.appendFileSync(${JSON.stringify(postLog)}, JSON.stringify({ args, payload }) + '\\n');`,
			`  const reviewsPath = ${JSON.stringify(reviewsState)};`,
			`  const reviewsEndpoint = ${JSON.stringify(`repos/frankekn/needlefish/pulls/${opts.prNumber}/reviews`)};`,
			"  const reviews = fs.existsSync(reviewsPath) ? JSON.parse(fs.readFileSync(reviewsPath, 'utf8')) : [];",
			"  const methodIdx = args.indexOf('-X');",
			"  const method = methodIdx >= 0 ? args[methodIdx + 1] : 'GET';",
			"  const apiPath = methodIdx >= 0 ? args[methodIdx + 2] : args[1];",
			"  if (apiPath === reviewsEndpoint && method === 'POST') {",
			"    const parsed = JSON.parse(payload);",
			"    reviews.push({ id: reviews.length + 1, body: parsed.body || '', user: { login: 'github-actions' } });",
			"    fs.writeFileSync(reviewsPath, JSON.stringify(reviews));",
			"  }",
			"  if (apiPath && apiPath.startsWith(reviewsEndpoint + '/') && method === 'PUT') {",
			"    const id = Number(apiPath.split('/').pop());",
			"    const parsed = JSON.parse(payload);",
			"    const review = reviews.find(r => r.id === id);",
			"    if (review) review.body = parsed.body || '';",
			"    fs.writeFileSync(reviewsPath, JSON.stringify(reviews));",
			"  }",
			`  const issueCommentsPath = ${JSON.stringify(issueCommentsState)};`,
			`  const issueCommentsEndpoint = ${JSON.stringify(`repos/frankekn/needlefish/issues/${opts.prNumber}/comments`)};`,
			"  if (apiPath === issueCommentsEndpoint && method === 'POST') {",
			"    const issueComments = fs.existsSync(issueCommentsPath) ? JSON.parse(fs.readFileSync(issueCommentsPath, 'utf8')) : [];",
			"    const parsed = JSON.parse(payload);",
			"    const nextId = issueComments.length + 1;",
			"    issueComments.push({ id: nextId, node_id: 'IC_node_' + nextId, body: parsed.body || '', user: { login: 'github-actions[bot]' } });",
			"    fs.writeFileSync(issueCommentsPath, JSON.stringify(issueComments));",
			"  }",
			"  process.stdout.write('{}');",
			"  process.exit(0);",
			"}",
			`if (args[1] === ${JSON.stringify(`repos/frankekn/needlefish/pulls/${opts.prNumber}`)}) {`,
			`  const countPath = ${JSON.stringify(countPath)};`,
			"  const count = fs.existsSync(countPath) ? Number(fs.readFileSync(countPath, 'utf8')) : 0;",
			"  fs.writeFileSync(countPath, String(count + 1));",
			`  const headSha = count === 0 ? ${JSON.stringify(targetHeadSha)} : ${JSON.stringify(latestHeadSha)};`,
			"  process.stdout.write(JSON.stringify({",
			"    state: 'open', title: 'PR', body: '',",
			"    comments_url: 'https://example.invalid/comments',",
			"    review_comments_url: 'https://example.invalid/reviews',",
			"    head: { sha: headSha },",
			`    base: { sha: ${JSON.stringify(baseSha)} }`,
			"  }));",
			"  process.exit(0);",
			"}",
			`if (args[1] === ${JSON.stringify(`repos/frankekn/needlefish/pulls/${opts.prNumber}/reviews`)}) {`,
			`  const reviewsPath = ${JSON.stringify(reviewsState)};`,
			"  const reviews = fs.existsSync(reviewsPath) ? JSON.parse(fs.readFileSync(reviewsPath, 'utf8')) : [];",
			"  process.stdout.write(JSON.stringify(reviews));",
			"  process.exit(0);",
			"}",
			"if (args[1] === 'https://example.invalid/comments' || args[1] === 'https://example.invalid/reviews') { process.stdout.write('[]'); process.exit(0); }",
			`if (args[1] === ${JSON.stringify(`repos/frankekn/needlefish/issues/${opts.prNumber}/comments`)}) {`,
			`  const issueCommentsPath = ${JSON.stringify(issueCommentsState)};`,
			"  const issueComments = fs.existsSync(issueCommentsPath) ? JSON.parse(fs.readFileSync(issueCommentsPath, 'utf8')) : [];",
			"  process.stdout.write(JSON.stringify(issueComments));",
			"  process.exit(0);",
			"}",
			"if (args[1] === 'graphql') {",
			`  fs.appendFileSync(${JSON.stringify(postLog)}, JSON.stringify({ args, payload: '' }) + '\\n');`,
			"  process.stdout.write('{}');",
			"  process.exit(0);",
			"}",
			"process.stderr.write(`unexpected gh args ${args.join(' ')}`);",
			"process.exit(2);",
		].join("\n"),
	);
	chmodSync(gh, 0o755);
	const reviewOutputFile = path.join(tmp, "review-output.json");
	writeFileSync(reviewOutputFile, opts.rawReview);
	writeFileSync(
		claude,
		[
			"#!/usr/bin/env node",
			"const fs = require('node:fs');",
			`process.stdout.write(fs.readFileSync(${JSON.stringify(reviewOutputFile)}, 'utf8'));`,
		].join("\n"),
	);
	chmodSync(claude, 0o755);
	process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
	process.env.GITHUB_REPOSITORY = "frankekn/needlefish";
	process.env.PR_BASE_SHA = baseSha;
	process.env.PR_HEAD_SHA = targetHeadSha;
	process.env.NEEDLEFISH_RUNNER = "claude";
	process.env.CLAUDE_BIN = claude;
	process.env.NEEDLEFISH_NO_FAST_PATH = "1";
	return { postLog, repo, reviewOutput: reviewOutputFile, reviewsState };
}

test("runGithub posts blocking findings as non-sticky review comments", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 9,
		rawReview: JSON.stringify({
			summary: "blocking finding",
			findings: [
				{
					severity: "P2",
					title: "bug",
					category: "bug",
					file: "README.md",
					lineStart: 1,
					lineEnd: 1,
					confidence: 0.9,
					whyItBreaks: "breaks",
					suggestedFix: "fix",
					validation: "test",
				},
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 9, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find((post) =>
		post.args.includes("repos/frankekn/needlefish/pulls/9/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.equal(payload.event, "COMMENT");
	assert.ok(payload.commit_id, "payload must keep commit_id");
	assert.equal(payload.comments.length, 1);
	const comment = payload.comments[0];
	assert.equal(comment.path, "README.md");
	assert.equal(comment.line, 1);
	assert.equal(comment.side, "RIGHT");
	assert.match(String(comment.body), /\*\*P2\*\* bug/);
	assert.match(String(comment.body), /\*\*Fix:\*\* fix/);
	assert.match(String(comment.body), /\*\*Validate:\*\* test/);
	assert.equal(process.exitCode, 1);
});

test("runGithub appends a suggestion block when replacement validates", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 14,
		rawReview: JSON.stringify({
			summary: "blocking finding",
			findings: [
				{
					severity: "P2",
					title: "bug",
					category: "bug",
					file: "README.md",
					lineStart: 1,
					lineEnd: 1,
					confidence: 0.9,
					whyItBreaks: "breaks",
					suggestedFix: "fix",
					validation: "test",
					replacement: { lines: ["fixed"] },
				},
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 14, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find((post) =>
		post.args.includes("repos/frankekn/needlefish/pulls/14/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.equal(payload.comments.length, 1);
	const comment = payload.comments[0];
	assert.equal(
		String(comment.body),
		"**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n```suggestion\nfixed\n```",
	);
});

test("runGithub omits fence-breaking suggestions but still posts inline comments", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 16,
		rawReview: JSON.stringify({
			summary: "blocking finding",
			findings: [
				{
					severity: "P2",
					title: "bug",
					category: "bug",
					file: "README.md",
					lineStart: 1,
					lineEnd: 1,
					confidence: 0.9,
					whyItBreaks: "breaks",
					suggestedFix: "fix",
					validation: "test",
					replacement: { lines: ['const fence = "```";'] },
				},
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 16, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find((post) =>
		post.args.includes("repos/frankekn/needlefish/pulls/16/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.equal(payload.comments.length, 1);
	const comment = payload.comments[0];
	assert.doesNotMatch(String(comment.body), /```suggestion/);
	assert.match(String(comment.body), /\*\*P2\*\* bug/);
	assert.match(String(comment.body), /\*\*Fix:\*\* fix/);
});

test("runGithub omits invalid suggestions but still posts inline comments", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 15,
		rawReview: JSON.stringify({
			summary: "blocking finding",
			findings: [
				{
					severity: "P2",
					title: "bug",
					category: "bug",
					file: "README.md",
					lineStart: 1,
					lineEnd: 2,
					confidence: 0.9,
					whyItBreaks: "breaks",
					suggestedFix: "fix",
					validation: "test",
					replacement: { lines: ["fixed", "second"] },
				},
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 15, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find((post) =>
		post.args.includes("repos/frankekn/needlefish/pulls/15/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.equal(payload.comments.length, 1);
	const comment = payload.comments[0];
	assert.doesNotMatch(String(comment.body), /```suggestion/);
	assert.match(String(comment.body), /\*\*Fix:\*\* fix/);
});

test("runGithub skips posting when the PR head changes after review", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 10,
		staleHeadAfterReview: true,
		rawReview: JSON.stringify({
			summary: "ok",
			findings: [],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 10, { timeoutMs: 1000 });

	assert.deepEqual(readPosts(fixture.postLog), []);
});

test("runGithub keeps non-anchorable findings in the review body only", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 11,
		rawReview: JSON.stringify({
			summary: "ghost finding",
			findings: [
				{
					severity: "P2",
					title: "ghost",
					category: "bug",
					file: "does-not-exist-in-diff.md",
					lineStart: 1,
					lineEnd: 1,
					confidence: 0.9,
					whyItBreaks: "breaks",
					suggestedFix: "fix",
					validation: "test",
				},
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 11, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find((post) =>
		post.args.includes("repos/frankekn/needlefish/pulls/11/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.deepEqual(payload.comments, []);
	assert.match(payload.body, /### 🟡 P2 F1: ghost/);
	assert.match(payload.body, /\*\*Problem:\*\* breaks/);
});

test("runGithub inlines only P0/P1/P2 when more than 20 findings are anchorable", async (t) => {
	const findings = [];
	for (let i = 0; i < 5; i++) {
		findings.push({
			severity: "P2",
			title: `p2-${i}`,
			category: "bug",
			file: "README.md",
			lineStart: 1,
			lineEnd: 1,
			confidence: 0.9,
			whyItBreaks: "w",
			suggestedFix: "f",
			validation: "v",
		});
	}
	for (let i = 0; i < 20; i++) {
		findings.push({
			severity: "P3",
			title: `p3-${i}`,
			category: "bug",
			file: "README.md",
			lineStart: 1,
			lineEnd: 1,
			confidence: 0.9,
			whyItBreaks: "w",
			suggestedFix: "f",
			validation: "v",
		});
	}

	const fixture = setupFixture(t, {
		prNumber: 12,
		rawReview: JSON.stringify({
			summary: "many findings",
			findings,
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 12, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find((post) =>
		post.args.includes("repos/frankekn/needlefish/pulls/12/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.equal(payload.comments.length, 5);
	for (const comment of payload.comments) {
		assert.match(String(comment.body), /\*\*P2\*\*/);
		assert.equal(comment.side, "RIGHT");
	}
	assert.match(payload.body, /### ⚪ P3 F6: p3-0/);
	assert.doesNotMatch(payload.body, /### 🟡 P2 F1: p2-0/);
});

// --- State marker pure-function tests ---

test("renderState produces an HTML comment with versioned JSON", () => {
	const marker = renderState("abc123", [
		mkFinding({ title: "Bug", lineStart: 5 }),
	]);
	assert.match(marker, /^<!-- needlefish-state: /);
	assert.match(marker, /-->$/);
	assert.match(marker, /"v":1/);
	assert.match(marker, /"headSha":"abc123"/);
	assert.match(marker, /"title":"bug"/);
});

test("parseState round-trips through renderState", () => {
	const findings: Finding[] = [
		mkFinding({ title: "Null deref", lineStart: 42 }),
		mkFinding({ title: "Race", lineStart: 100, file: "other.ts" }),
	];
	const marker = renderState("dead", findings);
	const parsed = parseState(`# Review\n\nbody text\n\n${marker}\n`);
	assert.ok(parsed);
	assert.equal(parsed!.v, 1);
	assert.equal(parsed!.headSha, "dead");
	assert.equal(parsed!.findings.length, 2);
	assert.equal(parsed!.findings[0].file, "README.md");
	assert.equal(parsed!.findings[0].lineStart, 42);
	assert.equal(parsed!.findings[0].title, "null deref");
	assert.equal(parsed!.findings[1].file, "other.ts");
});

test("parseState returns null for missing or corrupted markers", () => {
	assert.equal(parseState("no marker here"), null);
	assert.equal(parseState("<!-- needlefish-state: {bad json} -->"), null);
	assert.equal(
		parseState(
			'<!-- needlefish-state: {"v":2,"headSha":"x","findings":[]} -->',
		),
		null,
	);
	assert.equal(parseState('<!-- needlefish-state: {"v":1} -->'), null);
	assert.equal(
		parseState(
			'<!-- needlefish-state: {"v":1,"headSha":"x","findings":"nope"} -->',
		),
		null,
	);
	assert.equal(
		parseState(
			'<!-- needlefish-state: {"v":1,"headSha":"x","findings":[{"file":1}]} -->',
		),
		null,
	);
});

// --- matchFindings pure-function tests ---

test("matchFindings classifies identical findings as open", () => {
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 10, category: "bug", title: "null deref" },
	];
	const curr: Finding[] = [
		mkFinding({
			file: "a.ts",
			lineStart: 10,
			category: "bug",
			title: "null deref",
		}),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.open.length, 1);
	assert.equal(result.fresh.length, 0);
	assert.equal(result.resolvedCount, 0);
});

test("matchFindings tolerates line drift within 10 lines", () => {
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 10, category: "bug", title: "null deref" },
	];
	const curr: Finding[] = [
		mkFinding({
			file: "a.ts",
			lineStart: 20,
			category: "bug",
			title: "null deref",
		}),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.open.length, 1);
	assert.equal(result.fresh.length, 0);
	assert.equal(result.resolvedCount, 0);
});

test("matchFindings treats line drift beyond 10 as fresh and resolved", () => {
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 10, category: "bug", title: "null deref" },
	];
	const curr: Finding[] = [
		mkFinding({
			file: "a.ts",
			lineStart: 25,
			category: "bug",
			title: "null deref",
		}),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.open.length, 0);
	assert.equal(result.fresh.length, 1);
	assert.equal(result.resolvedCount, 1);
});

test("matchFindings matches on first-60-char title prefix", () => {
	const longTitle = "A".repeat(70);
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 1, category: "bug", title: "a".repeat(60) },
	];
	const curr: Finding[] = [
		mkFinding({
			file: "a.ts",
			lineStart: 1,
			category: "bug",
			title: longTitle,
		}),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.open.length, 1);
	assert.equal(result.fresh.length, 0);
});

test("matchFindings does not match same title in a different file", () => {
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 1, category: "bug", title: "null deref" },
	];
	const curr: Finding[] = [
		mkFinding({
			file: "b.ts",
			lineStart: 1,
			category: "bug",
			title: "null deref",
		}),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.fresh.length, 1);
	assert.equal(result.resolvedCount, 1);
});

test("matchFindings greedy-matches duplicate-title findings", () => {
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 1, category: "bug", title: "dup" },
		{ file: "a.ts", lineStart: 5, category: "bug", title: "dup" },
	];
	const curr: Finding[] = [
		mkFinding({ file: "a.ts", lineStart: 1, category: "bug", title: "dup" }),
		mkFinding({ file: "a.ts", lineStart: 5, category: "bug", title: "dup" }),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.open.length, 2);
	assert.equal(result.fresh.length, 0);
	assert.equal(result.resolvedCount, 0);
});

test("matchFindings counts resolved for prev keys with no match", () => {
	const prev: FindingKey[] = [
		{ file: "a.ts", lineStart: 1, category: "bug", title: "fixed" },
		{ file: "a.ts", lineStart: 10, category: "bug", title: "persists" },
	];
	const curr: Finding[] = [
		mkFinding({
			file: "a.ts",
			lineStart: 10,
			category: "bug",
			title: "persists",
		}),
	];
	const result = matchFindings(prev, curr);
	assert.equal(result.open.length, 1);
	assert.equal(result.fresh.length, 0);
	assert.equal(result.resolvedCount, 1);
});

// --- Multi-round integration tests ---

test("runGithub posts review with state marker on first round", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 20,
		rawReview: JSON.stringify({
			summary: "first round",
			findings: [mkFinding({ title: "bug", lineStart: 1 })],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 20, { timeoutMs: 1000 });

	const reviewPost = readPosts(fixture.postLog).find(
		(p) =>
			p.args.includes("POST") &&
			p.args.includes("repos/frankekn/needlefish/pulls/20/reviews"),
	);
	assert.ok(reviewPost);
	const payload = parseReviewPayload(reviewPost.payload);
	assert.match(payload.body, /needlefish-state:/);
	assert.equal(payload.comments.length, 1);
});

test("runGithub PUT-updates previous review when same findings persist", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 21,
		rawReview: JSON.stringify({
			summary: "persisting finding",
			findings: [mkFinding({ title: "bug", lineStart: 1 })],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 21, { timeoutMs: 1000 });
	const round1Count = readPosts(fixture.postLog).length;

	await runGithub(fixture.repo, 21, { timeoutMs: 1000 }, true);
	const round2Posts = readPosts(fixture.postLog).slice(round1Count);

	const putPost = round2Posts.find((p) => p.args.includes("PUT"));
	assert.ok(putPost, "round 2 should PUT-update the previous review");
	const putBody = parseReviewPayload(putPost.payload).body;
	assert.match(putBody, /Still open/);
	assert.match(putBody, /needlefish-state:/);

	const newReviewPost = round2Posts.find(
		(p) =>
			p.args.includes("POST") &&
			p.args.some((a) => a === "repos/frankekn/needlefish/pulls/21/reviews"),
	);
	assert.equal(
		newReviewPost,
		undefined,
		"no new review when no fresh findings",
	);
});

test("runGithub shows resolved count when a finding is fixed between rounds", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 22,
		rawReview: JSON.stringify({
			summary: "two findings",
			findings: [
				mkFinding({ title: "persisting", lineStart: 1 }),
				mkFinding({ title: "to-be-fixed", lineStart: 1 }),
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 22, { timeoutMs: 1000 });
	const round1Count = readPosts(fixture.postLog).length;

	writeFileSync(
		fixture.reviewOutput,
		JSON.stringify({
			summary: "one fixed and one new",
			findings: [
				mkFinding({ title: "persisting", lineStart: 1 }),
				mkFinding({ title: "new issue", lineStart: 1 }),
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	);

	await runGithub(fixture.repo, 22, { timeoutMs: 1000 }, true);
	const round2Posts = readPosts(fixture.postLog).slice(round1Count);

	const putPost = round2Posts.find((p) => p.args.includes("PUT"));
	assert.ok(putPost);
	const putBody = parseReviewPayload(putPost.payload).body;
	assert.match(putBody, /Still open/);
	assert.match(putBody, /✅ 1 resolved · 🆕 1 new/);
});

test("runGithub treats corrupted state marker as first round", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 23,
		rawReview: JSON.stringify({
			summary: "first",
			findings: [mkFinding({ title: "bug", lineStart: 1 })],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 23, { timeoutMs: 1000 });
	const round1Count = readPosts(fixture.postLog).length;

	const reviews = parseJson(readFileSync(fixture.reviewsState, "utf8"));
	assert.ok(Array.isArray(reviews));
	assert.ok(
		reviews.length > 0 && typeof reviews[0] === "object" && reviews[0] !== null,
	);
	Reflect.set(reviews[0], "body", "# Corrupted review with no state marker");
	writeFileSync(fixture.reviewsState, JSON.stringify(reviews));

	await runGithub(fixture.repo, 23, { timeoutMs: 1000 });
	const round2Posts = readPosts(fixture.postLog).slice(round1Count);

	const newReviewPost = round2Posts.find(
		(p) =>
			p.args.includes("POST") &&
			p.args.some((a) => a === "repos/frankekn/needlefish/pulls/23/reviews"),
	);
	assert.ok(newReviewPost, "corrupted state should cause a fresh POST review");
	const payload = parseReviewPayload(newReviewPost.payload);
	assert.match(payload.body, /needlefish-state:/);
	assert.equal(payload.comments.length, 1);
});

// --- Same-head dedupe ---

test("runGithub skips re-review when previous review has same head (no recheck)", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 30,
		rawReview: JSON.stringify({
			summary: "first round",
			findings: [mkFinding({ title: "bug", lineStart: 1 })],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 30, { timeoutMs: 1000 });
	const round1Count = readPosts(fixture.postLog).length;
	assert.ok(round1Count > 0, "round 1 should post");

	await runGithub(fixture.repo, 30, { timeoutMs: 1000 });
	const round2Posts = readPosts(fixture.postLog).slice(round1Count);

	assert.deepEqual(
		round2Posts,
		[],
		"no posts when same head already reviewed without --recheck",
	);
});

test("runGithub re-reviews same head when recheck is true", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 31,
		rawReview: JSON.stringify({
			summary: "first round",
			findings: [mkFinding({ title: "bug", lineStart: 1 })],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 31, { timeoutMs: 1000 });
	const round1Count = readPosts(fixture.postLog).length;
	assert.ok(round1Count > 0, "round 1 should post");

	await runGithub(fixture.repo, 31, { timeoutMs: 1000 }, true);
	const round2Posts = readPosts(fixture.postLog).slice(round1Count);

	const putPost = round2Posts.find((p) => p.args.includes("PUT"));
	assert.ok(
		putPost,
		"round 2 with --recheck should still review and PUT-update",
	);
});

// --- S5 invariant: error path posts a PR comment ---

test("runGithub posts a FAILED TO RUN PR comment when the review errors", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 40,
		rawReview: "definitely not json",
	});

	await runGithub(fixture.repo, 40, { timeoutMs: 1000 });

	const issueCommentPost = readPosts(fixture.postLog).find(
		(p) =>
			p.args.includes("POST") &&
			p.args.some((a) => a === "repos/frankekn/needlefish/issues/40/comments"),
	);
	assert.ok(issueCommentPost, "error path should post an issue comment");
	const body = String(
		(parseJson(issueCommentPost.payload) as { body?: unknown }).body ?? "",
	);
	assert.match(body, /FAILED TO RUN/);
	assert.match(body, /<!-- needlefish-error -->/);
});

// --- S5 invariant: re-review posts a round comment ---

test("runGithub posts a re-review round comment with counts on the second round", async (t) => {
	const fixture = setupFixture(t, {
		prNumber: 41,
		rawReview: JSON.stringify({
			summary: "two findings",
			findings: [
				mkFinding({ title: "persisting", lineStart: 1 }),
				mkFinding({ title: "to-be-fixed", lineStart: 1 }),
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	});

	await runGithub(fixture.repo, 41, { timeoutMs: 1000 });
	const round1Count = readPosts(fixture.postLog).length;

	writeFileSync(
		fixture.reviewOutput,
		JSON.stringify({
			summary: "one fixed and one new",
			findings: [
				mkFinding({ title: "persisting", lineStart: 1 }),
				mkFinding({ title: "new issue", lineStart: 1 }),
			],
			checked: ["checked"],
			residual_risks: [],
		}),
	);

	await runGithub(fixture.repo, 41, { timeoutMs: 1000 }, true);
	const round2Posts = readPosts(fixture.postLog).slice(round1Count);

	const roundCommentPost = round2Posts.find(
		(p) =>
			p.args.includes("POST") &&
			p.args.some((a) => a === "repos/frankekn/needlefish/issues/41/comments"),
	);
	assert.ok(roundCommentPost, "re-review should post a round comment");
	const body = String(
		(parseJson(roundCommentPost.payload) as { body?: unknown }).body ?? "",
	);
	assert.match(body, /Needlefish re-review/);
	// 1 resolved (to-be-fixed), 1 still open (persisting), 1 new (new issue).
	assert.match(body, /✅ 1 resolved/);
	assert.match(body, /❌ 1 still open/);
	assert.match(body, /🆕 1 new/);
	assert.match(body, /<!-- needlefish-round -->/);

	// Round 2 had no prior round comment, so nothing may be minimized — a
	// minimize call here means the round swept up its own fresh comment.
	const round2Minimize = round2Posts.filter((p) =>
		p.args.some((a) => a.includes("minimizeComment")),
	);
	assert.equal(round2Minimize.length, 0, "round 2 must not minimize anything");

	// Round 3: the round-2 comment (IC_node_1) must be minimized, and the
	// minimize must happen BEFORE this round's comment is posted (posting
	// first would minimize the fresh comment on the next round's scan).
	await runGithub(fixture.repo, 41, { timeoutMs: 1000 }, true);
	const round3Posts = readPosts(fixture.postLog).slice(
		round1Count + round2Posts.length,
	);
	const minimizeIdx = round3Posts.findIndex(
		(p) =>
			p.args.some((a) => a.includes("minimizeComment")) &&
			p.args.some((a) => a === "id=IC_node_1"),
	);
	const roundCommentIdx = round3Posts.findIndex(
		(p) =>
			p.args.includes("POST") &&
			p.args.some(
				(a) => a === "repos/frankekn/needlefish/issues/41/comments",
			) &&
			String(
				(parseJson(p.payload) as { body?: unknown }).body ?? "",
			).includes("<!-- needlefish-round -->"),
	);
	assert.ok(minimizeIdx >= 0, "round 3 should minimize the round-2 comment");
	assert.ok(roundCommentIdx >= 0, "round 3 should post a round comment");
	assert.ok(
		minimizeIdx < roundCommentIdx,
		"minimize must run before the new round comment is posted",
	);
});
