import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runLocal } from "./local";
import { fakeClaudeEnv, installFakeClaude, writeFakeClaude } from "./local-uncommitted-test-fixtures";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";

const TSX_IMPORT = process.env.NEEDLEFISH_TEST_TSX_IMPORT ?? "tsx";

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

test("runLocal skips tracked binary files while reviewing uncommitted text changes", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-tracked-binary-"));
  const repo = initRepo(tmp);
  const { promptPath } = installFakeClaude(t, tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 1;\n");
  writeFileSync(join(repo, "tracked image.bin"), Buffer.from([0, 1, 2, 3]));
  commitAll(repo, "base");
  writeFileSync(join(repo, "src", "app.ts"), "export const app = 2;\n");
  writeFileSync(join(repo, "tracked image.bin"), Buffer.from([0, 9, 2, 3]));
  writeFileSync(join(repo, "src", "untracked.ts"), "export const untracked = 1;\n");

  const result = await runLocal(repo, { cacheDir: join(tmp, "cache") });

  assert.match(result.reviewTarget ?? "", /Skipped tracked files: tracked image\.bin \(binary\)/);
  const prompts = readFileSync(promptPath, "utf8");
  assert.match(prompts, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
  assert.match(prompts, /\+export const app = 2;/);
  assert.match(prompts, /diff --git a\/src\/untracked\.ts b\/src\/untracked\.ts/);
  assert.equal(prompts.includes("diff --git a/tracked image.bin"), false);
  assert.equal(prompts.includes("Binary files"), false);
  assert.equal(prompts.includes('"path": "tracked image.bin"'), false);
});

test("runLocal reports skipped tracked binary files when no reviewable uncommitted patch remains", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-binary-only-"));
  const repo = initRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  writeFileSync(join(repo, "tracked image.bin"), Buffer.from([0, 1, 2, 3]));
  commitAll(repo, "base");
  writeFileSync(join(repo, "tracked image.bin"), Buffer.from([0, 9, 2, 3]));

  await assert.rejects(
    () => runLocal(repo, { cacheDir: join(tmp, "cache") }),
    /No uncommitted changes to review\. Skipped files: tracked image\.bin \(binary\)\./
  );
});

test("runLocal reports skipped tracked binary renames with spaces when no reviewable patch remains", async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "needlefish-local-binary-rename-"));
  const repo = initRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  gitText(["branch", "-M", "main"], repo);
  gitText(["config", "diff.renames", "true"], repo);
  writeFileSync(join(repo, "old image.bin"), Buffer.from([0, 1, 2, 3]));
  commitAll(repo, "base");
  gitText(["mv", "old image.bin", "new image.bin"], repo);

  await assert.rejects(
    () => runLocal(repo, { cacheDir: join(tmp, "cache") }),
    /No uncommitted changes to review\. Skipped files: old image\.bin \(binary\), new image\.bin \(binary\)\./
  );
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
