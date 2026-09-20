import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { review } from "./review.js";
import { findRunnerFailure } from "../shared/runner-failure.js";
import { commitAll, headSha, initRepo } from "../shared/codex-runner-test-fixtures.js";
import type { Bundle } from "../shared/schema.js";

for (const concurrency of [1, 2]) {
  test(`ACP startup failure stops queued deep work and critic; concurrency=${concurrency}`, { timeout: 20_000 }, async (t) => {
    const f = fixture(t, concurrency, "startup");
    await assert.rejects(review(f.bundle, { runner: "acp", timeoutMs: 6000 }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(findRunnerFailure(error)?.kind, "startup_timeout");
      const raw = (error as Error & { rawOutputs?: readonly string[] }).rawOutputs?.join("\n") ?? "";
      assert.match(raw, /failed-startup-transcript/);
      if (concurrency === 2) assert.match(raw, /late-sibling-transcript/, "drain in-flight work before collecting terminal diagnostics");
      assert.doesNotMatch(error.message, /failed-startup-transcript|late-sibling-transcript/);
      return true;
    });
    assert.equal(f.launches().length, 1 + concurrency, "one map and only the already-started deep workers; no retries");
    assert.ok(!f.phases().includes("critic"));
    for (const launch of f.launches()) {
      assert.equal(existsSync(launch.cwd), false);
      assert.equal(existsSync(launch.home), false);
    }
  });
}

test("post-startup deep failure keeps the existing conservative residual path", async (t) => {
  const f = fixture(t, 1, "review-failure");
  const result = await review(f.bundle, { runner: "acp", timeoutMs: 6000 });
  assert.equal(result.verdict, "needs_human");
  assert.ok(result.residualRisks.some((risk) => risk.blocks));
  assert.equal(f.launches().length, 5);
  assert.equal(f.phases().filter((phase) => phase === "deep").length, 3);
  assert.ok(f.phases().includes("critic"));
});

function fixture(t: TestContext, concurrency: number, mode: string) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-review-startup-"));
  const repo = initRepo(root);
  const baseSha = headSha(repo);
  mkdirSync(path.join(repo, "src"));
  for (let i = 0; i < 3; i++) writeFileSync(path.join(repo, `src/f${i}.ts`), `export const value${i} = ${i};\n`);
  commitAll(repo, "source changes");
  const bin = path.join(root, "agent.cjs");
  const home = path.join(root, "home");
  mkdirSync(home);
  const env: Record<string, string | undefined> = {
    NEEDLEFISH_ACP_BIN: bin, NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS: "750",
    NEEDLEFISH_NO_RETRY: "0", NEEDLEFISH_RETRY_MS: "1", NEEDLEFISH_EPHEMERAL_HOME: "1",
    NEEDLEFISH_ACP_AUTH_FILES: "", NEEDLEFISH_ACP_AUTH_ENV_VARS: "TEST_ACP_TOKEN",
    NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "TEST_ACP_TOKEN", TEST_ACP_TOKEN: "fake-auth",
    HOME: home, USERPROFILE: home, NEEDLEFISH_DEEP_CONCURRENCY: String(concurrency),
    NEEDLEFISH_EVAL_TRACE: "1", NEEDLEFISH_REVIEW_TIMEOUT_MS: "15000",
    NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS: "25", NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "250",
    NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS: "100",
  };
  const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  Object.assign(process.env, env);
  writeFileSync(bin, String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const root = ${JSON.stringify(root)};
const mode = ${JSON.stringify(mode)};
const mapped = path.join(root,'mapped');
let firstDeep = false;
if (fs.existsSync(mapped)) {
  try { fs.writeFileSync(path.join(root,'claimed'),'first',{flag:'wx'}); firstDeep = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
fs.appendFileSync(path.join(root,'launches'),JSON.stringify({cwd:process.cwd(),home:process.env.HOME})+'\n');
const send = (message) => process.stdout.write(JSON.stringify(message)+'\n');
readline.createInterface({input:process.stdin}).on('line',(line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    if (firstDeep && mode === 'startup') { process.stderr.write('failed-startup-transcript\n'); return; }
    send({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1}});
  } else if (request.method === 'session/new') {
    send({jsonrpc:'2.0',id:request.id,result:{sessionId:'s'}});
  } else if (request.method === 'session/prompt') {
    const input = request.params.prompt[0].text;
    const phase = input.includes('review-MAP pass') ? 'map' : input.includes('doing a DEEP review') ? 'deep' : 'critic';
    fs.appendFileSync(path.join(root,'phases'),phase+'\n');
    if (firstDeep && mode === 'review-failure') {
      send({jsonrpc:'2.0',id:request.id,error:{code:-32000,message:'auth required'}}); return;
    }
    const value = phase === 'map'
      ? {summary:'mapped',hotspots:Array.from({length:3},(_,i)=>({name:'surface-'+i,files:['src/f'+i+'.ts'],risk:'high',why:'changed source',edges:[]}))}
      : {summary:'reviewed',findings:[],checked:['source checked'],residual_risks:[]};
    setTimeout(() => {
      if (phase === 'map') fs.writeFileSync(mapped,'done');
      if (phase === 'deep') process.stderr.write('late-sibling-transcript\n');
      send({jsonrpc:'2.0',method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify(value)}}}});
      send({jsonrpc:'2.0',id:request.id,result:{stopReason:'end_turn'}});
    }, phase === 'deep' && mode === 'startup' ? 1400 : 0);
  }
});
`);
  chmodSync(bin, 0o755);
  const lines = (name: string): string[] => existsSync(path.join(root, name)) ? readFileSync(path.join(root, name), "utf8").trim().split("\n").filter(Boolean) : [];
  const bundle: Bundle = {
    repoPath: repo, baseSha, headSha: headSha(repo), patch: "source changes", patchStat: "3 source files changed",
    changedFiles: Array.from({ length: 3 }, (_, i) => ({ path: `src/f${i}.ts`, surface: "source" })),
    agentsMd: "(none)", prMeta: null, deep: true, focus: null,
  };
  return {
    bundle, phases: () => lines("phases"),
    launches: () => lines("launches").map((line): { cwd: string; home: string } => JSON.parse(line)),
  };
}
