import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { runLocal } from "./local";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";

const TSX_IMPORT = process.env.NEEDLEFISH_TEST_TSX_IMPORT ?? "tsx";

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function installFakeClaude(t: TestContext, tmp: string): { readonly promptPath: string } {
  const promptPath = join(tmp, "prompts.txt");
  const bin = join(tmp, "claude-bin.js");
  const previous = {
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
    noFastPath: process.env.NEEDLEFISH_NO_FAST_PATH,
    noRetry: process.env.NEEDLEFISH_NO_RETRY,
  };
  t.after(() => {
    restoreEnv("CLAUDE_BIN", previous.bin);
    restoreEnv("NEEDLEFISH_RUNNER", previous.runner);
    restoreEnv("NEEDLEFISH_NO_FAST_PATH", previous.noFastPath);
    restoreEnv("NEEDLEFISH_NO_RETRY", previous.noRetry);
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(promptPath)}, '\\n---PROMPT---\\n' + prompt);`,
      "  process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.NEEDLEFISH_NO_FAST_PATH = "1";
  process.env.NEEDLEFISH_NO_RETRY = "1";
  return { promptPath };
}

function fakeClaudeEnv(bin: string, home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_BIN: bin,
    HOME: home,
    NEEDLEFISH_NO_FAST_PATH: "1",
    NEEDLEFISH_NO_RETRY: "1",
  };
}

function writeFakeClaude(bin: string, promptPath: string): void {
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "let prompt = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { prompt += chunk; });",
      "process.stdin.on('end', () => {",
      `  fs.appendFileSync(${JSON.stringify(promptPath)}, '\\n---PROMPT---\\n' + prompt);`,
      "  process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
      "});",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
}

test("runLocal reviews staged unstaged and untracked changes when working tree is dirty", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-uncommitted-"));
  const repo = initRepo(tmp);
  const { promptPath } = installFakeClaude(t, tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  const base = headSha(repo);
  writeFileSync(join(repo, "README.md"), "fixture\nunstaged\n");
  writeFileSync(join(repo, "staged.ts"), "export const staged = 1;\n");
  gitText(["add", "staged.ts"], repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "new.ts"), "export const untracked = 1;\n");

  const result = await runLocal(repo, { cacheDir: join(tmp, "cache") });

  assert.equal(result.baseSha, base);
  assert.equal(result.headSha, "WORKING");
  assert.match(result.reviewTarget ?? "", /uncommitted changes/);
  const prompts = readFileSync(promptPath, "utf8");
  assert.match(prompts, /diff --git a\/README\.md b\/README\.md/);
  assert.match(prompts, /diff --git a\/staged\.ts b\/staged\.ts/);
  assert.match(prompts, /diff --git a\/src\/new\.ts b\/src\/new\.ts/);
  assert.match(prompts, /\+export const untracked = 1;/);
  const cache = readFileSync(join(tmp, "cache", "last-review.json"), "utf8");
  assert.match(cache, /"headSha": "WORKING"/);
});

test("runLocal excludes gitignored untracked files from the uncommitted review", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-ignore-"));
  const repo = initRepo(tmp);
  const { promptPath } = installFakeClaude(t, tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
  commitAll(repo, "ignore file");
  writeFileSync(join(repo, "visible.ts"), "export const visible = 1;\n");
  writeFileSync(join(repo, "ignored.ts"), "export const ignored = 1;\n");

  await runLocal(repo, { cacheDir: join(tmp, "cache") });

  const prompts = readFileSync(promptPath, "utf8");
  assert.match(prompts, /diff --git a\/visible\.ts b\/visible\.ts/);
  assert.equal(prompts.includes("ignored.ts"), false);
});

test("runLocal notes skipped binary oversize and total-capped untracked files", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-caps-"));
  const repo = initRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  writeFileSync(join(repo, "reviewed.md"), "review me\n");
  writeFileSync(join(repo, "image.png"), Buffer.from([0, 1, 2, 3]));
  writeFileSync(join(repo, "empty.txt"), "");
  writeFileSync(join(repo, "large.md"), "x".repeat(201 * 1024));
  mkdirSync(join(repo, "docs"));
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(repo, "docs", `cap-${i}.md`), `${i}\n${"x".repeat(190 * 1024)}`);
  }

  const result = await runLocal(repo, { cacheDir: join(tmp, "cache") });

  const reviewTarget = result.reviewTarget ?? "";
  assert.match(reviewTarget, /Skipped untracked files:/);
  assert.match(reviewTarget, /image\.png \(binary\)/);
  assert.match(reviewTarget, /empty\.txt \(empty\)/);
  assert.match(reviewTarget, /large\.md \(over 200KB\)/);
  assert.match(reviewTarget, /docs\/cap-5\.md \(total untracked content cap 1MB\)/);
});

test("runLocal reviews all nonignored files on unborn HEAD", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-unborn-"));
  const repo = join(tmp, "repo");
  mkdirSync(repo);
  gitText(["init"], repo);
  const { promptPath } = installFakeClaude(t, tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(repo, "ignored.ts"), "export const ignored = 1;\n");

  const result = await runLocal(repo, { cacheDir: join(tmp, "cache") });

  assert.equal(result.baseSha, "EMPTY");
  assert.equal(result.headSha, "WORKING");
  assert.match(result.reviewTarget ?? "", /uncommitted changes/);
  const prompts = readFileSync(promptPath, "utf8");
  assert.match(prompts, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.equal(prompts.includes("diff --git a/ignored.ts b/ignored.ts"), false);
});

test("local CLI reports a friendly git init message outside git repos", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-nongit-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const result = spawnSync(
    process.execPath,
    ["--import", TSX_IMPORT, join(process.cwd(), "src/cli.ts"), "--repo", tmp],
    { cwd: process.cwd(), encoding: "utf8" }
  );

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim().split(/\r?\n/).length, 1);
  assert.match(result.stderr, /git init/);
  assert.equal(result.stderr.includes("fatal:"), false);
});

test("runLocal uses branch review when the worktree is clean", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-clean-"));
  const repo = initRepo(tmp);
  const { promptPath } = installFakeClaude(t, tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  const base = headSha(repo);
  gitText(["checkout", "-b", "feature"], repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 1;\n");
  commitAll(repo, "feature");
  const head = headSha(repo);

  const result = await runLocal(repo, { cacheDir: join(tmp, "cache") });

  assert.equal(result.baseSha, base);
  assert.equal(result.headSha, head);
  assert.equal(result.reviewTarget, undefined);
  const prompts = readFileSync(promptPath, "utf8");
  assert.equal(prompts.includes('"headSha": "WORKING"'), false);
  assert.match(prompts, /diff --git a\/src\/feature\.ts b\/src\/feature\.ts/);
});

test("local CLI --branch keeps dirty worktree on the old branch diff path", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-branch-"));
  const repo = initRepo(tmp);
  const home = join(tmp, "home");
  const bin = join(tmp, "claude-bin.js");
  const promptPath = join(tmp, "prompts.txt");
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFakeClaude(bin, promptPath);

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "feature.ts"), "export const feature = 1;\n");
  commitAll(repo, "feature");
  const head = headSha(repo);
  writeFileSync(join(repo, "dirty.ts"), "export const dirty = 1;\n");

  const result = spawnSync(
    process.execPath,
    [
      "--import",
      TSX_IMPORT,
      join(process.cwd(), "src/cli.ts"),
      "--repo",
      repo,
      "--json",
      "--branch",
      "--runner",
      "claude",
    ],
    { cwd: process.cwd(), encoding: "utf8", env: fakeClaudeEnv(bin, home) }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /uncommitted changes are not included/);
  assert.match(result.stdout, new RegExp(`"headSha": "${head}"`));
  const prompts = readFileSync(promptPath, "utf8");
  assert.match(prompts, /diff --git a\/src\/feature\.ts b\/src\/feature\.ts/);
  assert.equal(prompts.includes("dirty.ts"), false);
});
