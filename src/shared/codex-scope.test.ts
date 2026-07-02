import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCodex } from "./codex";
import { headSha, initRepo, readStringArray } from "./codex-runner-test-fixtures";

test("runCodex hides dirty target files from codex runner", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex-bin.js");
  const argsPath = path.join(tmp, "args.json");
  const previous = process.env.CODEX_BIN;
  const previousReasoningEffort = process.env.CODEX_REASONING_EFFORT;
  t.after(() => {
    if (previous === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = previous;
    if (previousReasoningEffort === undefined) delete process.env.CODEX_REASONING_EFFORT;
    else process.env.CODEX_REASONING_EFFORT = previousReasoningEffort;
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const args = process.argv.slice(2);",
      `fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(args));`,
      "const out = args[args.indexOf('--output-last-message') + 1];",
      "fs.writeFileSync(out, JSON.stringify({ dirtyVisible: fs.existsSync('dirty-only.txt'), cwd: process.cwd() }));",
    ].join("\n")
  );
  chmodSync(bin, 0o755);
  writeFileSync(path.join(repo, "dirty-only.txt"), "dirty");
  process.env.CODEX_BIN = bin;
  delete process.env.CODEX_REASONING_EFFORT;

  const output = await runCodex("prompt", {
    repoPath: repo,
    runner: "codex",
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output.includes('"dirtyVisible":false'), true);
  assert.equal(output.includes(repo), false);
  const args = readStringArray(argsPath);
  assert.equal(args.includes("--ignore-user-config"), true);
  assert.equal(args.includes('model_reasoning_effort="medium"'), true);
});
