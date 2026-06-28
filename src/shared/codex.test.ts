import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractJson, runCodex } from "./codex";

function readStringArray(file: string): readonly string[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    throw new Error("expected string array");
  }
  return raw;
}

function initRepo(root: string): string {
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  const result = spawnSync("git", ["init"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git init failed: ${result.stderr ?? ""}`);
  }
  return repo;
}

test("extractJson parses fenced JSON output", () => {
  const text = "preface\n```json\n{\"ok\":true}\n```\ntrailer";

  const parsed = extractJson(text);

  assert.deepEqual(parsed, { ok: true });
});

test("extractJson rejects output without a JSON object", () => {
  const text = "no object here";

  assert.throws(() => extractJson(text), /no JSON object found/);
});

test("runCodex retry backoff yields the event loop", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const bin = path.join(tmp, "codex-bin.js");
  const state = path.join(tmp, "state");
  const previous = {
    bin: process.env.CODEX_BIN,
    retry: process.env.CODEX_RETRY_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous.bin;
    if (previous.retry === undefined) delete process.env.CODEX_RETRY_MS;
    else process.env.CODEX_RETRY_MS = previous.retry;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const out = process.argv[process.argv.indexOf('--output-last-message') + 1];",
      `const state = ${JSON.stringify(state)};`,
      "if (!fs.existsSync(state)) {",
      "  fs.writeFileSync(state, 'failed');",
      "  process.stderr.write('first failure');",
      "  process.exit(1);",
      "}",
      "fs.writeFileSync(out, '{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.CODEX_RETRY_MS = "50";

  let timerFired = false;
  setTimeout(() => {
    timerFired = true;
  }, 0);

  const output = await runCodex("prompt", { repoPath: tmp, timeoutMs: 1000 });

  assert.equal(output, "{\"ok\":true}");
  assert.equal(timerFired, true);
});

test("runCodex invokes claude in non-interactive plan mode", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
  const argsPath = path.join(tmp, "args.json");
  const inputPath = path.join(tmp, "stdin.txt");
  const previous = {
    bin: process.env.CLAUDE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
    codexTimeout: process.env.CODEX_TIMEOUT_MS,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    if (previous.codexTimeout === undefined) delete process.env.CODEX_TIMEOUT_MS;
    else process.env.CODEX_TIMEOUT_MS = previous.codexTimeout;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2)));`,
      `fs.writeFileSync(${JSON.stringify(inputPath)}, fs.readFileSync(0, 'utf8'));`,
      "process.stdout.write('{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";
  process.env.CODEX_TIMEOUT_MS = "0";

  const output = await runCodex("prompt", { repoPath: repo });
  const args = readStringArray(argsPath);

  assert.equal(output, "{\"ok\":true}");
  assert.deepEqual(args.slice(0, 7), [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    "plan",
    "--safe-mode",
    "--no-session-persistence",
  ]);
  assert.equal(args.includes("prompt"), false);
  assert.equal(readFileSync(inputPath, "utf8"), "prompt");
});

test("runCodex extracts opencode json text output", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "opencode-bin.js");
  const argsPath = path.join(tmp, "args.json");
  const inputPath = path.join(tmp, "prompt-copy.txt");
  const previous = {
    bin: process.env.OPENCODE_BIN,
    runner: process.env.NEEDLEFISH_RUNNER,
  };
  t.after(() => {
    if (previous.bin === undefined) delete process.env.OPENCODE_BIN;
    else process.env.OPENCODE_BIN = previous.bin;
    if (previous.runner === undefined) delete process.env.NEEDLEFISH_RUNNER;
    else process.env.NEEDLEFISH_RUNNER = previous.runner;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
      "const promptFile = args[args.indexOf('--file') + 1];",
      `fs.writeFileSync(${JSON.stringify(inputPath)}, fs.readFileSync(promptFile, 'utf8'));`,
      "process.stdout.write(JSON.stringify({ type: 'text', part: { text: '{\"ok\":true}' } }) + '\\n');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.OPENCODE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "opencode";

  const output = await runCodex("prompt", { repoPath: repo, timeoutMs: 1000 });
  const args = readStringArray(argsPath);

  assert.equal(output, "{\"ok\":true}");
  assert.deepEqual(args.slice(0, 5), ["run", "--format", "json", "--pure", "--dir"]);
  assert.equal(args[5], repo);
  assert.equal(args[6], "--file");
  assert.equal(args.at(-1), "Use the attached prompt file as your complete instruction.");
  assert.equal(args.includes("prompt"), false);
  assert.equal(readFileSync(inputPath, "utf8"), "prompt");
});

test("runCodex rejects non-codex runners that dirty the target repo", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
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
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "fs.writeFileSync('runner-wrote.txt', 'dirty');",
      "process.stdout.write('{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";

  await assert.rejects(
    () => runCodex("prompt", { repoPath: repo, timeoutMs: 1000 }),
    /claude runner changed the target worktree/
  );
});

test("runCodex rejects non-codex runners when the target starts dirty", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "claude-bin.js");
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
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "process.stdout.write('{\"ok\":true}');",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(repo, "preexisting.txt"), "dirty");
  process.env.CLAUDE_BIN = bin;
  process.env.NEEDLEFISH_RUNNER = "claude";

  await assert.rejects(
    () => runCodex("prompt", { repoPath: repo, timeoutMs: 1000 }),
    /claude runner requires a clean target worktree/
  );
});
