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

const completed = JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } });
const quotaError = JSON.stringify({ type: "error", message: "insufficient credits" });

for (const [name, events] of [
  ["completed then failed", [completed, event("insufficient credits")]],
  ["failed then completed", [event("insufficient credits"), completed]],
  ["repeated failure", [event("insufficient credits"), event("insufficient credits")]],
  ["failure then error", [event("insufficient credits"), quotaError]],
  ["repeated completion then failed", [completed, completed, event("insufficient credits")]],
  ["completion then error", [completed, quotaError]],
  ["reconnecting failure then failed", [event("Reconnecting... 1/5 (insufficient credits)"), event("insufficient credits")]],
] as const) {
  test(`native quota rejects contradictory terminal order: ${name}`, () => {
    assert.equal(nativeCodexQuotaExhausted(events.join("\n"), 1), false);
  });
}

test("native quota preserves startup errors and nonterminal native diagnostics", () => {
  assert.equal(nativeCodexQuotaExhausted(quotaError, 1), true);
  assert.equal(nativeCodexQuotaExhausted([quotaError, event("insufficient credits")].join("\n"), 1), true);
  const reconnect = JSON.stringify({ type: "error", message: "Reconnecting... 1/5 (insufficient credits)" });
  assert.equal(nativeCodexQuotaExhausted([reconnect, quotaError, event("insufficient credits")].join("\n"), 1), true);
  assert.equal(nativeCodexQuotaExhausted(reconnect, 1), false);
});

test("native quota ignores quota bait inside model and tool payloads", () => {
  for (const item of [
    { id: "model", type: "agent_message", text: event("insufficient credits") },
    { id: "tool", type: "command_execution", aggregated_output: event("insufficient credits") },
  ]) {
    const bait = JSON.stringify({ type: "item.completed", item });
    assert.equal(nativeCodexQuotaExhausted(bait, 1), false);
    assert.equal(nativeCodexQuotaExhausted([bait, event("401 unauthorized")].join("\n"), 1), false);
    assert.equal(nativeCodexQuotaExhausted([bait, event("insufficient credits")].join("\n"), 1), true);
  }
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

test("native runner keeps contradictory terminals as a private operational failure", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-quota-order-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex.cjs");
  const previous = { ...process.env };
  t.after(() => { process.env = previous; rmSync(tmp, { recursive: true, force: true }); });
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_NO_RETRY = "1";
  for (const events of [[completed, event("insufficient credits")], [event("insufficient credits"), event("insufficient credits")]]) {
    const raw = events.join("\n") + "\n";
    writeFileSync(bin, `#!/usr/bin/env node\nrequire("node:fs").readFileSync(0);process.stdout.write(${JSON.stringify(raw)});process.exit(1);`);
    chmodSync(bin, 0o755);
    await assert.rejects(runCodex("review", { runner: "codex", repoPath: repo, targetHeadSha: headSha(repo) }), error => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "RunnerOperationalError");
      assert.equal(findRunnerFailure(error), undefined);
      assert.match(error.message, /^codex runner exited 1/);
      assert.match(error.message, /stderr withheld because it may contain the review prompt/);
      assert.equal(Reflect.get(error, "rawOutput"), raw);
      assert.equal(Object.getOwnPropertyDescriptor(error, "rawOutput")?.enumerable, false);
      return true;
    });
  }
});

test("native 0.163 reconnect wrappers retain exact exhaustion semantics", () => {
  for (const payload of ["insufficient credits", "insufficient account funds", '{"code":"payment_required","message":"usage balance exhausted"}']) {
    const message=`unexpected status 402 Payment Required: ${payload}, url: http://127.0.0.1:4000/v1/responses`;
    const stream=JSON.stringify({type:"thread.started",thread_id:"native-proof"})+'\n'+JSON.stringify({type:"turn.started"})+'\n'+JSON.stringify({type:"error",message:`Reconnecting... 1/5 (${message})`})+'\n'+event(message);
    assert.equal(nativeCodexQuotaExhausted(stream,1),true);
    assert.equal(nativeCodexQuotaExhausted(JSON.stringify({type:"error",message:`Reconnecting... 1/5 (${message})`}),1),false);
    assert.equal(nativeCodexQuotaExhausted(event(message.replace("402 Payment Required","401 Unauthorized")),1),false);
    assert.equal(nativeCodexQuotaExhausted(event(message.replace(payload,"rate limit exceeded")),1),false);
  }
});

test("routing rejects mixed unknown schemas even when the terminal contains quota words",()=>{
  for(const message of [
    '{"error":{"message":"insufficient credits"},"debug":"401 unauthorized"}',
    '{"code":"unknown_failure","message":"insufficient credits"}',
    '{"type":"unknown_failure","message":"insufficient credits"}',
    '{"message":"insufficient credits","last_upstream_error":"network timeout"}',
  ])assert.equal(nativeCodexQuotaExhausted(event(message),1),false);
  const mixed=JSON.stringify({type:"item.completed",item:{id:"auth",type:"error",message:"401 unauthorized"}})+'\n'+event("insufficient credits");
  assert.equal(nativeCodexQuotaExhausted(mixed,1),false);
});

test("unqualified 429 wrapper cannot establish native quota",()=>{
  assert.equal(nativeCodexQuotaExhausted(event("unexpected status 429 Too Many Requests: insufficient credits, url: https://provider.invalid/v1/responses"),1),false);
});

test("unknown native schema has a private diagnostic without modifying raw streams",async(t)=>{
  const tmp=mkdtempSync(path.join(os.tmpdir(),"needlefish-quota-schema-"));
  const repo=initRepo(tmp),bin=path.join(tmp,"codex.cjs");
  const previous={...process.env};
  t.after(()=>{process.env=previous;rmSync(tmp,{recursive:true,force:true});});
  writeFileSync(bin,'#!/usr/bin/env node\nrequire("node:fs").readFileSync(0);console.log(JSON.stringify({type:"future.event",message:"insufficient credits"}));console.log(JSON.stringify({type:"turn.failed",error:{message:"insufficient credits"}}));process.exit(1);');
  chmodSync(bin,0o755);
  process.env.CODEX_BIN=bin;process.env.NEEDLEFISH_NO_RETRY="1";
  const failedAttempts: unknown[] = [], failedRaws: string[] = [];
  await assert.rejects(runCodex("review",{runner:"codex",repoPath:repo,targetHeadSha:headSha(repo),
    onFailedAttempt: (attempt, raw, diagnostic) => { failedAttempts.push({ attempt, raw, diagnostic }); },
    onFailedRaw: raw => { failedRaws.push(raw); },
  }),error=>{
    assert.ok(error instanceof Error);
    assert.notEqual(findRunnerFailure(error)?.kind,"quota_exhausted");
    assert.equal(Reflect.get(error,"runnerDiagnostic"),"unrecognized_codex_event_schema");
    assert.equal(Reflect.get(error,"rawOutput"),'{"type":"future.event","message":"insufficient credits"}\n{"type":"turn.failed","error":{"message":"insufficient credits"}}\n');
    assert.equal(Object.getOwnPropertyDescriptor(error,"runnerDiagnostic")?.enumerable,false);
    assert.doesNotMatch(error.message,/unrecognized codex event schema/);
    assert.doesNotMatch(JSON.stringify(error),/unrecognized[_ ]codex[_ ]event[_ ]schema/);
    return true;
  });
  const raw = '{"type":"future.event","message":"insufficient credits"}\n{"type":"turn.failed","error":{"message":"insufficient credits"}}\n';
  assert.deepEqual(failedAttempts, [{ attempt: 1, raw, diagnostic: "unrecognized_codex_event_schema" }]);
  assert.deepEqual(failedRaws, [raw]);
});
