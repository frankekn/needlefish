import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractJson, runCodex } from "./codex";
import { headSha, initRepo } from "./codex-runner-test-fixtures";

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
  const repo = initRepo(tmp);
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

  const output = await runCodex("prompt", {
    repoPath: repo,
    targetHeadSha: headSha(repo),
    timeoutMs: 1000,
  });

  assert.equal(output, "{\"ok\":true}");
  assert.equal(timerFired, true);
});
