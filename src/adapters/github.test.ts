import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { runGithub } from "./github";

test("runGithub normalizes relative repo paths before building prompts", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-github-test-"));
  const repo = initRepo(tmp);
  const fakeBin = path.join(tmp, "bin");
  const gh = path.join(fakeBin, "gh");
  const claude = path.join(fakeBin, "claude");
  const promptPath = path.join(tmp, "prompts.txt");
  const promptRepoPath = path.join(tmp, "prompt-repo-path.txt");
  const previous = {
    path: process.env.PATH,
    repository: process.env.GITHUB_REPOSITORY,
    head: process.env.PR_HEAD_SHA,
    base: process.env.PR_BASE_SHA,
    runner: process.env.NEEDLEFISH_RUNNER,
    claude: process.env.CLAUDE_BIN,
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
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  const baseSha = headSha(repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "README.md"), "feature\n");
  commitAll(repo, "feature");
  const targetHeadSha = headSha(repo);

  mkdirSync(fakeBin);
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      "if (args[0] !== 'api') process.exit(2);",
      "if (args.includes('--input')) { fs.readFileSync(0, 'utf8'); process.stdout.write('{}'); process.exit(0); }",
      `if (args[1] === 'repos/frankekn/needlefish/pulls/7') { process.stdout.write(${JSON.stringify(
        JSON.stringify({
          state: "open",
          title: "PR",
          body: "",
          comments_url: "https://example.invalid/comments",
          review_comments_url: "https://example.invalid/reviews",
          head: { sha: targetHeadSha },
          base: { sha: baseSha },
        })
      )}); process.exit(0); }`,
      "if (args[1] === 'https://example.invalid/comments' || args[1] === 'https://example.invalid/reviews') { process.stdout.write('[]'); process.exit(0); }",
      "process.stderr.write(`unexpected gh args ${args.join(' ')}`);",
      "process.exit(2);",
    ].join("\n")
  );
  chmodSync(gh, 0o755);
  writeFileSync(
    claude,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const input = fs.readFileSync(0, 'utf8');",
      `fs.appendFileSync(${JSON.stringify(promptPath)}, input);`,
      "const match = input.match(/\"repoPath\":\\s*\"([^\"]+)\"/);",
      `if (match && !fs.existsSync(${JSON.stringify(promptRepoPath)})) fs.writeFileSync(${JSON.stringify(promptRepoPath)}, match[1]);`,
      "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
    ].join("\n")
  );
  chmodSync(claude, 0o755);
  process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
  process.env.GITHUB_REPOSITORY = "frankekn/needlefish";
  process.env.PR_BASE_SHA = baseSha;
  process.env.PR_HEAD_SHA = targetHeadSha;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.CLAUDE_BIN = claude;

  const relativeRepo = path.relative(process.cwd(), repo);
  await runGithub(relativeRepo, 7, { timeoutMs: 1000 });

  const prompts = readFileSync(promptPath, "utf8");
  assert.equal(prompts.includes(relativeRepo), false);
  const repoPathInPrompt = readFileSync(promptRepoPath, "utf8");
  assert.equal(path.isAbsolute(repoPathInPrompt), true);
  assert.equal(path.basename(repoPathInPrompt), "runner-repo");
});

test("runGithub skips closed PRs before review", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-github-closed-test-"));
  const fakeBin = path.join(tmp, "bin");
  const gh = path.join(fakeBin, "gh");
  const logPath = path.join(tmp, "gh.log");
  const previous = {
    path: process.env.PATH,
    repository: process.env.GITHUB_REPOSITORY,
  };
  t.after(() => {
    if (previous.path === undefined) delete process.env.PATH;
    else process.env.PATH = previous.path;
    if (previous.repository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previous.repository;
    rmSync(tmp, { recursive: true, force: true });
  });

  mkdirSync(fakeBin);
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.appendFileSync(${JSON.stringify(logPath)}, args.join(' ') + '\\n');`,
      "if (args[0] !== 'api') process.exit(2);",
      `if (args[1] === 'repos/frankekn/needlefish/pulls/8') { process.stdout.write(${JSON.stringify(
        JSON.stringify({ state: "closed", title: "Closed PR" })
      )}); process.exit(0); }`,
      "process.stderr.write(`unexpected gh args ${args.join(' ')}`);",
      "process.exit(2);",
    ].join("\n")
  );
  chmodSync(gh, 0o755);
  process.env.PATH = `${fakeBin}:${previous.path ?? ""}`;
  process.env.GITHUB_REPOSITORY = "frankekn/needlefish";

  await runGithub(tmp, 8, { runner: "claude", timeoutMs: 1000 });

  const ghCalls = readFileSync(logPath, "utf8").trim().split("\n");
  assert.deepEqual(ghCalls, ["api repos/frankekn/needlefish/pulls/8"]);
});
