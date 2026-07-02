import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { runGithub } from "./github";

type Post = {
  readonly args: readonly string[];
  readonly payload: string;
};

type Fixture = {
  readonly postLog: string;
  readonly repo: string;
};

type FixtureOptions = {
  readonly prNumber: number;
  readonly rawReview: string;
  readonly staleHeadAfterReview?: boolean;
};

function isPost(raw: unknown): raw is Post {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const args = Reflect.get(raw, "args");
  const payload = Reflect.get(raw, "payload");
  return (
    Array.isArray(args) &&
    args.every((item) => typeof item === "string") &&
    typeof payload === "string"
  );
}

function readPosts(file: string): readonly Post[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const raw: unknown = JSON.parse(line);
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
  const raw: unknown = JSON.parse(payload);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("expected review payload object");
  }
  const record = raw as Record<string, unknown>;
  const comments = Array.isArray(record.comments) ? record.comments as Record<string, unknown>[] : [];
  return {
    commit_id: typeof record.commit_id === "string" ? record.commit_id : "",
    body: typeof record.body === "string" ? record.body : "",
    event: typeof record.event === "string" ? record.event : "",
    comments,
  };
}

function setupFixture(t: TestContext, opts: FixtureOptions): Fixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-github-posting-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const gh = path.join(fakeBin, "gh");
  const claude = path.join(fakeBin, "claude");
  const postLog = path.join(tmp, "posts.jsonl");
  const previous = {
    path: process.env.PATH,
    repository: process.env.GITHUB_REPOSITORY,
    head: process.env.PR_HEAD_SHA,
    base: process.env.PR_BASE_SHA,
    runner: process.env.NEEDLEFISH_RUNNER,
    claude: process.env.CLAUDE_BIN,
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
      "if (args[1] === 'https://example.invalid/comments' || args[1] === 'https://example.invalid/reviews') { process.stdout.write('[]'); process.exit(0); }",
      "process.stderr.write(`unexpected gh args ${args.join(' ')}`);",
      "process.exit(2);",
    ].join("\n")
  );
  chmodSync(gh, 0o755);
  writeFileSync(
    claude,
    ["#!/usr/bin/env node", `process.stdout.write(${JSON.stringify(opts.rawReview)});`].join("\n")
  );
  chmodSync(claude, 0o755);
  process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
  process.env.GITHUB_REPOSITORY = "frankekn/needlefish";
  process.env.PR_BASE_SHA = baseSha;
  process.env.PR_HEAD_SHA = targetHeadSha;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.CLAUDE_BIN = claude;
  return { postLog, repo };
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
    post.args.includes("repos/frankekn/needlefish/pulls/9/reviews")
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
    post.args.includes("repos/frankekn/needlefish/pulls/11/reviews")
  );
  assert.ok(reviewPost);
  const payload = parseReviewPayload(reviewPost.payload);
  assert.deepEqual(payload.comments, []);
  assert.match(payload.body, /### P2: ghost/);
  assert.match(payload.body, /\*\*Why this breaks:\*\* breaks/);
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
    post.args.includes("repos/frankekn/needlefish/pulls/12/reviews")
  );
  assert.ok(reviewPost);
  const payload = parseReviewPayload(reviewPost.payload);
  assert.equal(payload.comments.length, 5);
  for (const comment of payload.comments) {
    assert.match(String(comment.body), /\*\*P2\*\*/);
    assert.equal(comment.side, "RIGHT");
  }
  assert.match(payload.body, /### P3: p3-0/);
  assert.doesNotMatch(payload.body, /### P2: p2-0/);
});
