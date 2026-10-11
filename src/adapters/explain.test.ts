import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { WITHHELD_MESSAGE } from "../shared/outbound-screen.js";
import { runGithubExplain, screenExplanation } from "./explain.js";
import { renderState } from "./github.js";

const KNOWN = "abc123def456ghi789jkl0";

test("screenExplanation withholds an explanation carrying a runner credential value", () => {
  assert.throws(
    () => screenExplanation(`the key is ${KNOWN}`, { FAKE_API_KEY: KNOWN }),
    (err: unknown) => err instanceof Error && err.message === WITHHELD_MESSAGE && !err.message.includes(KNOWN),
  );
});

test("screenExplanation redacts a credential-shaped string and keeps the rest", () => {
  const token = `ghp_${"a1".repeat(18)}`;
  const out = screenExplanation(`see ${token} here`, {});
  assert.equal(out, "see [redacted] here");
});

test("screenExplanation returns clean text unchanged", () => {
  assert.equal(screenExplanation("plain explanation", {}), "plain explanation");
});

test("runGithubExplain hands the model Needlefish's latest finding keys, not its review prose", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-explain-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const promptLog = path.join(tmp, "prompts.txt");
  const postLog = path.join(tmp, "posts.jsonl");
  const previous = {
    path: process.env.PATH,
    repository: process.env.GITHUB_REPOSITORY,
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
  };
  t.after(() => {
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.repository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous.repository;
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  const base = headSha(repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "app.ts"), "export const x = 1;\n");
  commitAll(repo, "feature");
  const head = headSha(repo);

  const state = renderState(head, [
    {
      severity: "P2",
      title: "Doctor base check fails on a dirty worktree",
      category: "bug",
      file: "app.ts",
      lineStart: 1,
      lineEnd: 1,
      confidence: 0.9,
      whyItBreaks: "breaks",
      suggestedFix: "fix",
      validation: "test",
    },
  ]);
  const reviewBody = `CHANGES REQUESTED ⚠️ — 1 blocking\n\nCoverage: full diff reviewed in one pass (1 file)\n\n## Findings\n\n| 1 | P2 | Doctor base check fails on a dirty worktree | app.ts:1 |\n\n${state}\n`;
  const prView = {
    number: 9,
    title: "PR",
    body: null,
    comments: [],
    reviews: [
      { author: { login: "github-actions" }, state: "COMMENTED", body: reviewBody },
      { author: { login: "frankekn" }, state: "COMMENTED", body: "LGTM from me, one nit inline." },
    ],
    statusCheckRollup: [],
    baseRefOid: base,
    headRefOid: head,
    baseRefName: "main",
    headRefName: "feature",
  };
  const reviewsPage = [[{ id: 1, body: reviewBody, user: { login: "github-actions[bot]", type: "Bot" } }]];
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(prView))});`,
      "  process.exit(0);",
      "}",
      "if (args[1] === '--paginate' && args[2] === '--slurp' && args[3] === 'repos/frankekn/needlefish/pulls/9/reviews') {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(reviewsPage))});`,
      "  process.exit(0);",
      "}",
      // An Actions token may not call GET /user; trust then rests on the bot identity.
      "if (args[1] === 'user') { process.stderr.write('HTTP 403'); process.exit(1); }",
      "if (args.includes('--input')) {",
      `  fs.appendFileSync(${JSON.stringify(postLog)}, JSON.stringify({ args, payload: fs.readFileSync(0, 'utf8') }) + '\\n');`,
      "  process.stdout.write('{}');",
      "  process.exit(0);",
      "}",
      "process.stderr.write('unexpected gh args ' + args.join(' '));",
      "process.exit(2);",
    ].join("\n")
  );
  writeFileSync(
    path.join(fakeBin, "claude"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(promptLog)}, fs.readFileSync(0, 'utf8'));`,
      "process.stdout.write('The guard runs after the write.');",
    ].join("\n")
  );
  chmodSync(path.join(fakeBin, "gh"), 0o755);
  chmodSync(path.join(fakeBin, "claude"), 0o755);
  process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
  process.env.GITHUB_REPOSITORY = "frankekn/needlefish";
  process.env.CLAUDE_BIN = path.join(fakeBin, "claude");
  process.env.NEEDLEFISH_RUNNER = "claude";

  await runGithubExplain(repo, 9, "dirty worktree", { timeoutMs: 1000 });

  const prompt = readFileSync(promptLog, "utf8");
  const bundle = prompt.slice(prompt.indexOf("# Context bundle"), prompt.indexOf("# Diff"));
  const context = JSON.parse(bundle.slice(bundle.indexOf("{"))) as {
    latestReview?: { headSha: string; findings: { file: string; lineStart: number; title: string }[] };
    prMeta: { reviews: string[] };
  };
  assert.equal(context.latestReview?.headSha, head);
  assert.deepEqual(
    context.latestReview?.findings.map((f) => [f.file, f.lineStart, f.title]),
    [["app.ts", 1, "doctor base check fails on a dirty worktree"]]
  );
  assert.deepEqual(context.prMeta.reviews, ["LGTM from me, one nit inline."]);
  assert.equal(prompt.includes("needlefish-state"), false);
  assert.equal(prompt.includes("Coverage: full diff"), false);

  const posted = readFileSync(postLog, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { args: string[]; payload: string });
  const comment = posted.find((p) => p.args.includes("repos/frankekn/needlefish/issues/9/comments"));
  assert.ok(comment, "explain posts an issue comment");
  const body = (JSON.parse(comment.payload) as { body: string }).body;
  assert.ok(body.startsWith("## 🔍 Needlefish explain\n\nThe guard runs after the write."));
  assert.ok(body.endsWith("\n<!-- needlefish-explain -->"));
});
