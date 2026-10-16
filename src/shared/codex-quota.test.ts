import test from "node:test";
import assert from "node:assert/strict";
import { nativeCodexQuotaExhausted } from "./codex.js";

const event = (message: string) => JSON.stringify({ type: "turn.failed", error: { message } });
test("native quota requires complete terminal JSONL and nonzero exit", () => {
  for (const message of ["insufficient credits", "You have insufficient credits to make this request.", 'ERROR: {"error":{"code":"insufficient_quota","message":"No balance"}}']) {
    assert.equal(nativeCodexQuotaExhausted(event(message), 1), true);
  }
  for (const [stdout, status] of [
    [event("insufficient credits"), 0], [event("insufficient credits"), null],
    ["insufficient credits", 1], [event("429 Too Many Requests"), 1],
    [event("quota exhausted"), 1], [event("insufficient credits; 401 unauthorized"), 1],
    [event("insufficient credits") + '\nplain text', 1],
    [event("insufficient credits") + '\n' + JSON.stringify({type:"turn.started"}), 1],
    [event("401 unauthorized") + '\n' + event("insufficient credits"), 1],
    [event("insufficient credits") + '\n' + JSON.stringify({type:"item.completed",item:{id:"x",type:"agent_message",text:"hello"}}), 1],
    [JSON.stringify({type:"turn.failed",error:{message:429}}), 1],
  ] as const) assert.equal(nativeCodexQuotaExhausted(stdout, status), false, stdout);
});

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { initRepo, headSha } from "./codex-runner-test-fixtures.js";
import { runCodex } from "./codex.js";
import { findRunnerFailure } from "./runner-failure.js";

test("native runner exposes typed nonretry quota through operational wrapper", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-quota-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex.cjs");
  const previous = process.env.CODEX_BIN;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_BIN; else process.env.CODEX_BIN = previous; rmSync(tmp, {recursive:true,force:true}); });
  writeFileSync(bin, '#!/usr/bin/env node\nrequire("node:fs").readFileSync(0);console.log(JSON.stringify({type:"turn.failed",error:{message:"insufficient credits"}}));process.exit(1);');
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  let attempts = 0;
  await assert.rejects(runCodex("review", {runner:"codex",repoPath:repo,targetHeadSha:headSha(repo),onStat:s=>{ attempts=s.attempts; }}), error => {
    assert.equal(findRunnerFailure(error)?.kind, "quota_exhausted");
    assert.equal(findRunnerFailure(error)?.retryable, false);
    return true;
  });
  assert.equal(attempts, 1);
});
