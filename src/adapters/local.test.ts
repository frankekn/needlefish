import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocal, runLocalPr, terminalProgress } from "./local";
import type { ReviewProgressEvent } from "../core/review";
import { serializeReviewResult } from "../shared/schema";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";

function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): { readonly [key: string]: unknown } {
  const value: unknown = JSON.parse(raw);
  if (!isJsonObject(value)) {
    throw new Error("expected JSON object");
  }
  return value;
}

test("runLocal fails loudly when explicit PR metadata cannot be fetched", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const gh = path.join(fakeBin, "gh");
  const previousPath = process.env.PATH;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "README.md"), "feature\n");
  commitAll(repo, "feature");

  mkdirSync(fakeBin);
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      "process.stderr.write('gh auth required');",
      "process.exit(1);",
    ].join("\n")
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${fakeBin}:${previousPath ?? ""}`;

  await assert.rejects(
    () => runLocal(repo, { pr: 24 }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /--pr 24 requested, but PR metadata could not be fetched: gh pr view 24/
      );
      assert.ok(error.cause instanceof Error, "the gh failure must be preserved as cause");
      assert.match(error.cause.message, /gh pr view 24/);
      return true;
    }
  );
});

test("runLocal normalizes relative repo paths before building prompts", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-test-"));
  const repo = initRepo(tmp);
  const promptPath = path.join(tmp, "prompts.txt");
  const bin = path.join(tmp, "claude-bin.js");
  const cacheDir = path.join(tmp, "cache");
  const previous = {
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
    noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    if (previous.noFastPath === undefined) delete process.env.NEEDLEFISH_NO_FAST_PATH;
    else process.env.NEEDLEFISH_NO_FAST_PATH = previous.noFastPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "README.md"), "feature\n");
  commitAll(repo, "feature");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(promptPath)}, fs.readFileSync(0, 'utf8'));`,
      "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.NEEDLEFISH_NO_FAST_PATH = "1";

  const relativeRepo = path.relative(process.cwd(), repo);
  await runLocal(relativeRepo, { cacheDir });

  const prompts = readFileSync(promptPath, "utf8");
  assert.equal(prompts.includes(`"repoPath": "${relativeRepo}"`), false);
  assert.equal(prompts.includes("runner-repo"), true);
});

test("local --json writes pure ReviewResult JSON matching the cache", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-json-test-"));
  const repo = initRepo(tmp);
  const home = path.join(tmp, "home");
  const bin = path.join(tmp, "claude-bin.js");
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
  commitAll(repo, "feature");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), "--repo", repo, "--json", "--runner", "claude"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: {
        ...process.env,
        CLAUDE_BIN: bin,
        HOME: home,
        NEEDLEFISH_NO_FAST_PATH: "1",
      },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const stdoutJson = parseJsonObject(result.stdout);
  assert.equal(stdoutJson.schemaVersion, 1);
  assert.equal(stdoutJson.verdict, "pass");

  const cachePath = path.join(home, ".cache", "needlefish", "repo", "last-review.json");
  const cache = readFileSync(cachePath, "utf8");
  assert.equal(cache, result.stdout);
  const cacheJson = parseJsonObject(cache);
  assert.equal(cacheJson.schemaVersion, 1);
});

test("local --pr records the PR base tip as prBaseSha, distinct from the merge base", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-pr-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const cacheDir = path.join(tmp, "cache");
  const previous = {
    path: process.env.PATH,
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
  };
  t.after(() => {
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "app.ts"), "export const x = 1;\n");
  commitAll(repo, "feature");
  const head = headSha(repo);
  // Advance main past the merge base so the PR base tip and merge base differ.
  gitText(["checkout", "main"], repo);
  writeFileSync(path.join(repo, "MAIN.md"), "main moved\n");
  commitAll(repo, "main advanced");
  const baseTip = headSha(repo);
  gitText(["checkout", "feature"], repo);

  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'pr' && process.argv[3] === 'view') {",
      "  process.stdout.write(JSON.stringify({",
      "    number: 7, title: 'PR', body: null, comments: [], reviews: [],",
      "    statusCheckRollup: [],",
      `    baseRefOid: ${JSON.stringify(baseTip)},`,
      `    headRefOid: ${JSON.stringify(head)},`,
      "    baseRefName: 'main', headRefName: 'feature',",
      "  }));",
      "  process.exit(0);",
      "}",
      "process.stderr.write('unexpected gh call');",
      "process.exit(1);",
    ].join("\n")
  );
  writeFileSync(
    path.join(fakeBin, "claude"),
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(path.join(fakeBin, "gh"), 0o755);
  chmodSync(path.join(fakeBin, "claude"), 0o755);
  process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
  process.env.CLAUDE_BIN = path.join(fakeBin, "claude");
  process.env.NEEDLEFISH_RUNNER = "claude";

  const result = await runLocalPr(repo, 7, { cacheDir });

  const mergeBase = gitText(["merge-base", baseTip, head], repo);
  assert.equal(result.prNumber, 7);
  assert.equal(result.prBaseSha, baseTip);
  assert.equal(result.baseSha, mergeBase);
  assert.notEqual(result.prBaseSha, result.baseSha);
  assert.equal(
    result.reviewTarget,
    `Review target: PR #7 ${mergeBase}..${head}`
  );
  assert.equal(result.verdict, "pass");

  const serialized = parseJsonObject(serializeReviewResult(result));
  assert.equal(serialized.prNumber, 7);
  assert.equal(serialized.prBaseSha, baseTip);
  assert.equal(serialized.baseSha, mergeBase);
});

test("local pr prompts keep human PR discussion and drop Needlefish's own review text", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-pr-discussion-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const cacheDir = path.join(tmp, "cache");
  const promptLog = path.join(tmp, "prompts.txt");
  const previous = {
    path: process.env.PATH,
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
    noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
  };
  t.after(() => {
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    if (previous.noFastPath === undefined) delete process.env.NEEDLEFISH_NO_FAST_PATH;
    else process.env.NEEDLEFISH_NO_FAST_PATH = previous.noFastPath;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  const base = headSha(repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "app.ts"), "export const x = 1;\n");
  commitAll(repo, "feature");
  const head = headSha(repo);

  // Shapes as `gh pr view --json comments,reviews` returns them: gh renders
  // the Actions identity as the plain login "github-actions".
  const roundComment =
    "**Needlefish re-review** @ 1a2b3c4 — ✅ 1 resolved · ❌ 0 still open · 🆕 0 new → LGTM\n<!-- needlefish-round -->";
  const prView = {
    number: 7,
    title: "PR",
    body: null,
    comments: [
      { author: { login: "github-actions" }, body: roundComment },
      {
        author: { login: "github-actions" },
        body: "⚠️ **Needlefish review FAILED TO RUN** — this red check is an infra failure, not a code verdict.\n\n```\nspawn codex ETIMEDOUT\n```\n\nRe-trigger: push a new commit or re-run with --recheck.\n<!-- needlefish-error -->",
      },
      {
        author: { login: "frankekn" },
        body: `${roundComment.split("\n").map((line) => `> ${line}`).join("\n")}\n\nThe resolved one was intentional, see the design note.`,
      },
    ],
    reviews: [
      {
        author: { login: "github-actions" },
        state: "COMMENTED",
        body: 'LGTM ✅ — Pruned the single candidate finding.\n\nCoverage: full diff reviewed in one pass (1 file)\n\n## Findings\n\nNo actionable findings.\n\n<!-- needlefish-state: {"v":1,"headSha":"1a2b3c4d","findings":[]} -->\n',
      },
      { author: { login: "github-actions" }, state: "COMMENTED", body: "" },
      { author: { login: "frankekn" }, state: "APPROVED", body: "LGTM from me, one nit inline." },
      {
        author: { login: "chatgpt-codex-connector" },
        state: "COMMENTED",
        body: "### 💡 Codex Review\n\nHere are some automated review suggestions for this pull request.",
      },
    ],
    statusCheckRollup: [],
    baseRefOid: base,
    headRefOid: head,
    baseRefName: "main",
    headRefName: "feature",
  };
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "gh"),
    [
      "#!/usr/bin/env node",
      "if (process.argv[2] === 'pr' && process.argv[3] === 'view') {",
      `  process.stdout.write(${JSON.stringify(JSON.stringify(prView))});`,
      "  process.exit(0);",
      "}",
      "process.stderr.write('unexpected gh call');",
      "process.exit(1);",
    ].join("\n")
  );
  writeFileSync(
    path.join(fakeBin, "claude"),
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(promptLog)}, fs.readFileSync(0, 'utf8'));`,
      "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
    ].join("\n")
  );
  chmodSync(path.join(fakeBin, "gh"), 0o755);
  chmodSync(path.join(fakeBin, "claude"), 0o755);
  process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
  process.env.CLAUDE_BIN = path.join(fakeBin, "claude");
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.NEEDLEFISH_NO_FAST_PATH = "1";

  await runLocalPr(repo, 7, { cacheDir });
  const prompts = readFileSync(promptLog, "utf8");

  assert.ok(prompts.includes("The resolved one was intentional"), "human comment reaches the model");
  assert.ok(prompts.includes("> **Needlefish re-review**"), "the human's quote stays with the human's comment");
  assert.ok(prompts.includes("LGTM from me, one nit inline."), "human review body reaches the model");
  assert.ok(prompts.includes("Codex Review"), "another reviewer's text is not Needlefish's");
  assert.equal(prompts.includes('"**Needlefish re-review**'), false, "own round comment dropped");
  assert.equal(prompts.includes("FAILED TO RUN"), false, "own infra-failure comment dropped");
  assert.equal(prompts.includes("needlefish-state"), false, "own review body dropped");
  assert.equal(prompts.includes("Pruned the single candidate finding"), false, "own review body dropped");
});

test("terminalProgress writes stage lines only to a TTY without --json", () => {
  const writes: string[] = [];
  const sink = (isTTY: boolean | undefined) => ({
    ...(isTTY === undefined ? {} : { isTTY }),
    write: (chunk: string) => writes.push(chunk),
  });
  assert.equal(terminalProgress(sink(undefined), false), undefined);
  assert.equal(terminalProgress(sink(false), false), undefined);
  assert.equal(terminalProgress(sink(true), true), undefined);
  const onProgress = terminalProgress(sink(true), false);
  assert.ok(onProgress);
  onProgress({ stage: "deep", done: 2, failed: 1, total: 3, tail: true });
  onProgress({ stage: "done", durationMs: 72_049 });
  assert.deepEqual(writes, [
    "needlefish: deep review: 2/3 done, 1 failed\n",
    "needlefish: done in 72.0s\n",
  ]);
});

test("progress leaves model prompts and the cached result unchanged", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-progress-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
  const promptLog = path.join(tmp, "prompts.txt");
  const previous = {
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
  commitAll(repo, "feature");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(promptLog)}, fs.readFileSync(0, 'utf8'));`,
      "const finding = { severity: 'P2', title: 'Bug', category: 'bug', file: 'src/app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'breaks', suggestedFix: 'fix', validation: 'test' };",
      "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [finding], checked: ['checked'], residual_risks: [] }));",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";

  const runOnce = async (label: string, withProgress: boolean) => {
    const cacheDir = path.join(tmp, `cache-${label}`);
    rmSync(promptLog, { force: true });
    const events: ReviewProgressEvent[] = [];
    await runLocal(repo, { cacheDir }, withProgress ? (e) => events.push(e) : undefined);
    const cache = readFileSync(path.join(cacheDir, "last-review.json"), "utf8")
      .replace(/"(durationMs|totalDurationMs)": \d+/g, '"$1": 0');
    // The throwaway runner clone lives under a fresh temp dir per run.
    const prompts = readFileSync(promptLog, "utf8").replace(/needlefish-managed-[^/]+/g, "needlefish-managed-X");
    return { cache, prompts, events };
  };
  const off = await runOnce("off", false);
  const on = await runOnce("on", true);

  assert.deepEqual(
    on.events.map((e) => e.stage),
    ["review", "critic", "done"]
  );
  assert.equal(on.prompts, off.prompts);
  assert.equal(on.cache, off.cache);
  assert.match(on.cache, /"verdict": "changes_requested"/);
});

test("local review prints no progress when stderr is not a TTY", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-pipe-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "export const value = 1;\n");
  commitAll(repo, "feature");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);

  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), "--repo", repo, "--runner", "claude"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_BIN: bin, HOME: path.join(tmp, "home") },
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /pass/i);
  assert.equal(result.stderr, "");
});

test("runLocal names --base when the detected base ref does not exist", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-test-"));
  const repo = initRepo(tmp);
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  gitText(["branch", "-M", "trunk"], repo);

  await assert.rejects(
    () => runLocal(repo, { localMode: "branch" }),
    /Base ref 'main' cannot be used \(git merge-base main HEAD failed: .*\)\. Pass --base <ref> to name the branch to compare against\.$/,
  );
});

test("runLocal tells the user what to do when the branch has no diff against its base", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-test-"));
  const repo = initRepo(tmp);
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  gitText(["branch", "-M", "main"], repo);

  await assert.rejects(
    () => runLocal(repo, { localMode: "branch" }),
    /No diff between [0-9a-f]{40} and HEAD \(main\)\. Nothing to review\. Commit changes on this branch first, or pass --base <ref> to compare against another branch\.$/,
  );
});
