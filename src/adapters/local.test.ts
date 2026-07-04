import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocal } from "./local";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures";

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
