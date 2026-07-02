import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocal } from "./local";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures";

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
    /--pr 24 requested, but PR metadata could not be fetched: gh pr view 24/
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
