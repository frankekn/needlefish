import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { commitAll, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { parseArgs } from "../cli/args.js";

const firstKey = "fake-session-first-%41-value";
const secondKey = "fake-session-second-%42-value";
const cliPath = path.resolve("src/cli.ts");
const revision = (file: string) => `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}`;
function fixture(t: TestContext, mode = "safe", adapter = "codex") {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "nf-session-review-")));
  const repo = initRepo(root), config = path.join(root, "config"), home = path.join(root, "home"), managed = path.join(root, "managed");
  mkdirSync(config, { mode: 0o700 }); mkdirSync(home);
  const file = path.join(config, "connections.json"), bin = path.join(root, "agent.cjs"), records = path.join(root, "calls.jsonl"), envReceipt = path.join(root, "env.json");
  writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n"); commitAll(repo, "base");
  writeFileSync(path.join(repo, "app.ts"), "export const value = 2;\n");
  const connections = ["first", "second"].map((id, index) => ({ id, adapter, model: id,
    ...(adapter === "acp" ? { launch: { command: bin, args: ["{model}"] }, auth: { env: { AGENT_API_KEY: index ? "SECOND_REF" : "FIRST_REF" } } }
      : { auth: { env: { CODEX_API_KEY: index ? "SECOND_REF" : "FIRST_REF" }, route: { kind: "openai" } } }) }));
  writeFileSync(file, JSON.stringify({ version: 1, connections }), { mode: 0o600 });
  const script = `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const mode=${JSON.stringify(mode)},adapter=${JSON.stringify(adapter)},model=adapter==='acp'?process.argv[2]:process.argv[process.argv.indexOf('-m')+1];
const key=process.env.CODEX_API_KEY||process.env.AGENT_API_KEY;
function respond(prompt,repo){
 const stage=prompt.includes('adversarial critic')?'critic':'review';
 fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({model,stage,pg:process.pid,source:fs.readFileSync(path.join(repo,'app.ts'),'utf8'),keyMatches:key===(model==='first'?${JSON.stringify(firstKey)}:${JSON.stringify(secondKey)}),promptPrivate:prompt.includes(${JSON.stringify(firstKey)})||prompt.includes(${JSON.stringify(secondKey)}),argsPrivate:process.argv.some(arg=>arg.includes(${JSON.stringify(firstKey)})||arg.includes(${JSON.stringify(secondKey)})),sourceRefsAbsent:!process.env.FIRST_REF&&!process.env.SECOND_REF})+'\\n');
 if(mode==='cancel'){
  const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  fs.writeFileSync(${JSON.stringify(path.join(root, "descendant.json"))},JSON.stringify({pg:process.pid,child:child.pid}));
  process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});setInterval(()=>{},1000);return null;
 }
 if(model==='first'&&['quota','all-quota','deadline'].includes(mode)||mode==='all-quota'){
  if(mode==='quota'){fs.writeFileSync(${JSON.stringify(file)},'invalid config after capture');fs.writeFileSync(${JSON.stringify(path.join(repo, "app.ts"))},'changed source after capture');}
  if(mode==='deadline')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
  console.log(JSON.stringify({type:'turn.failed',error:{message:'insufficient credits'}}));process.exit(1);
 }
 if(mode==='deadline')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,1500);
 if(mode==='auth'||mode==='unknown'){console.log(JSON.stringify({type:'turn.failed',error:{message:mode==='auth'?'401 unauthorized':'429 Too Many Requests'}}));process.exit(1);}
 if(mode==='invalid')return 'invalid JSON';
 const secret=mode==='cross-key'?${JSON.stringify(secondKey)}:${JSON.stringify(firstKey)};
 const summary=mode==='leak'||mode==='cross-key'?Array.from(Buffer.from(secret)).map(byte=>'%'+byte.toString(16).padStart(2,'0')).join(''):mode==='literal-leak'?secret:mode==='json-leak'?Array.from(secret).map(char=>'\\\\u'+char.charCodeAt(0).toString(16).padStart(4,'0')).join(''):model+' clean';
 return JSON.stringify({summary,findings:[],checked:['FILES inspected=[app.ts]'],residual_risks:[]});
}
if(adapter==='codex'){
 const prompt=fs.readFileSync(0,'utf8'),repo=JSON.parse(prompt.slice('The repository to inspect is '.length,prompt.indexOf('. Your startup directory'))),out=respond(prompt,repo);
 if(out!==null)fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],out);
}else{
 const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');let repo;
 require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
 if(m.method==='session/new'){repo=m.params.cwd;send({id:m.id,result:{sessionId:'s'}});}
 if(m.method==='session/prompt'){const out=respond(m.params.prompt.map(p=>p.text||'').join(''),repo);if(out===null)return;
 send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:out}}}});send({id:m.id,result:{stopReason:'end_turn'}});}
 });
}
`;
  writeFileSync(bin, script); chmodSync(bin, 0o700);
  const preload = path.join(root, "preload.cjs");
  writeFileSync(preload, `const fs=require('node:fs');const before=JSON.stringify(process.env),original=fs.writeFileSync;let cacheWrites=0;fs.writeFileSync=function(file,...args){if(String(file).endsWith('/last-review.json'))cacheWrites++;return original.call(this,file,...args)};require('node:module').syncBuiltinESMExports();process.on('exit',()=>original(${JSON.stringify(envReceipt)},JSON.stringify({unchanged:before===JSON.stringify(process.env),cacheWrites})));`);
  const env = { PATH: process.env.PATH, HOME: home, NEEDLEFISH_CONNECTIONS_FILE: file, CODEX_BIN: bin,
    NEEDLEFISH_TMPDIR: managed, NEEDLEFISH_REVIEW_TIMEOUT_MS: "invalid ambient budget", NEEDLEFISH_NO_RETRY: "1",
    NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "100", NEEDLEFISH_TERMINATION_GRACE_MS: "200", NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS: "30", NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS: "100",
    FIRST_REF: "ambient-first-must-not-mix", SECOND_REF: "ambient-second-must-not-mix" };
  const request = { repo, scope: "local-uncommitted", expectedRevision: revision(file), ids: ["first"], budgetMs: 10000, credentialMode: "session", sources: { FIRST_REF: firstKey } };
  const rows = (): { model: string; stage: string; pg: number; source: string; keyMatches: boolean; promptPrivate: boolean; argsPrivate: boolean; sourceRefsAbsent: boolean }[] => existsSync(records) ? readFileSync(records, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  t.after(() => { for (const row of rows()) { try { process.kill(-row.pg, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } } rmSync(root, { recursive: true, force: true }); });
  const args = ["--require", preload, "--import", "tsx", cliPath, "connections", "review", "--json"];
  const runRaw = (input: string, extraEnv = {}) => spawnSync(process.execPath, args, { env: { ...env, ...extraEnv }, input, encoding: "utf8", timeout: 20000 });
  const run = (input: unknown = request, extraEnv = {}) => runRaw(JSON.stringify(input), extraEnv);
  const cache = () => {
    const directory = path.join(home, ".cache", "needlefish");
    if (!existsSync(directory)) return [];
    return readdirSync(directory).flatMap(name => { const file = path.join(directory, name, "last-review.json"); return existsSync(file) ? [file] : []; });
  };
  return { root, repo, file, home, managed, records, request, run, runRaw, rows, cache, env, args, envReceipt };
}
function failure(result: SpawnSyncReturns<string>, code: string) {
  assert.equal(result.status, 1, String(result.stderr)); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(String(result.stdout)), { schemaVersion: 1, ok: false, code });
}

test("review machine command takes all selection inputs through stdin", () => {
  assert.deepEqual(parseArgs(["connections", "review", "--json"]), { kind: "connections", operation: "review" });
  assert.throws(() => parseArgs(["connections", "review", "--json", "--repo", "/fake"]), /invalid_request/);
});

test("selected session credentials bind once without global env writes and cache only the final result", t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stderr, "");
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdict, "pass"); assert.equal(output.summary, "first clean");
  assert.deepEqual(f.rows().map(row => [row.model, row.stage, row.source, row.keyMatches, row.promptPrivate, row.argsPrivate, row.sourceRefsAbsent]), [
    ["first", "review", "export const value = 2;\n", true, false, false, true], ["first", "critic", "export const value = 2;\n", true, false, false, true],
  ]);
  assert.deepEqual(JSON.parse(readFileSync(f.envReceipt, "utf8")), { unchanged: true, cacheWrites: 1 });
  assert.equal(f.cache().length, 1); assert.deepEqual(JSON.parse(readFileSync(f.cache()[0], "utf8")), output);
  assert.equal(readFileSync(f.file, "utf8").includes(firstKey), false);
  assert.equal((result.stdout + readFileSync(f.cache()[0], "utf8")).includes(firstKey), false);
  assert.equal("providerAccount" in output, false);
});

for (const [name, modify, code] of [
  ["extra reference", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, sources: { ...r.sources, UNUSED_REF: secondKey } }), "invalid_request"],
  ["missing reference", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, sources: {} }), "invalid_request"],
  ["missing selected route", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, ids: ["deleted"] }), "invalid_request"],
  ["duplicate selected route", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, ids: ["first", "first"] }), "invalid_request"],
  ["stale raw revision", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, expectedRevision: "sha256:" + "0".repeat(64) }), "revision_conflict"],
  ["mixed credentials", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, credentialMode: "existing" }), "invalid_request"],
  ["unbounded budget", (r: ReturnType<typeof fixture>["request"]) => ({ ...r, budgetMs: 2147483648 }), "invalid_request"],
] as const) {
  test(`session ingress rejects ${name} before model or cache writes`, t => {
    const f = fixture(t), original = readFileSync(f.file, "utf8"); failure(f.run(modify(f.request)), code);
    assert.deepEqual(f.rows(), []); assert.deepEqual(f.cache(), []); assert.equal(readFileSync(f.file, "utf8"), original);
  });
}

test("session mode refuses auth-free routes and existing mode uses only its explicit ambient refs", t => {
  const f = fixture(t); const document = JSON.parse(readFileSync(f.file, "utf8")); delete document.connections[0].auth;
  writeFileSync(f.file, JSON.stringify(document));
  failure(f.run({ ...f.request, expectedRevision: revision(f.file), sources: {} }), "invalid_request");
  const g = fixture(t); const result = g.run({ ...g.request, credentialMode: "existing", sources: {} }, { FIRST_REF: firstKey });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).summary, "first clean");
  assert.equal(g.rows().every(row => row.keyMatches), true);
});

test("quota restarts one shared session from frozen routes/source and writes one final cache", t => {
  const f = fixture(t, "quota"), result = f.run({ ...f.request, ids: ["first", "second"], sources: { FIRST_REF: firstKey, SECOND_REF: secondKey } });
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
  assert.equal(output.summary, "second clean"); assert.equal(output.verdict, "pass");
  assert.deepEqual(f.rows().map(row => [row.model, row.stage, row.source, row.keyMatches]), [
    ["first", "review", "export const value = 2;\n", true], ["second", "review", "export const value = 2;\n", true], ["second", "critic", "export const value = 2;\n", true],
  ]);
  assert.equal(f.cache().length, 1); assert.deepEqual(JSON.parse(readFileSync(f.cache()[0], "utf8")), output);
  assert.deepEqual(output.runtime?.model, { status: "known", value: "second" });
  assert.deepEqual(JSON.parse(readFileSync(f.envReceipt, "utf8")), { unchanged: true, cacheWrites: 1 });
  assert.equal(output.runtime?.reviewBudgetMs, 10000);
  assert.deepEqual(output.runtime?.qualification, { matchStatus: "unqualified" });
});

for (const [mode, adapter] of [["literal-leak", "acp"], ["leak", "acp"], ["json-leak", "acp"], ["cross-key", "acp"], ["cross-key", "codex"], ["all-quota", "codex"], ["auth", "codex"], ["unknown", "codex"], ["invalid", "codex"]]) {
  test(`machine ${adapter} ${mode} cannot publish a pass or partial cache`, t => {
    const f = fixture(t, mode, adapter), input = mode === "cross-key" || mode === "all-quota" || mode === "auth" || mode === "unknown" ? { ...f.request, ids: ["first", "second"], sources: { FIRST_REF: firstKey, SECOND_REF: secondKey } } : f.request;
    failure(f.run(input), "review_incomplete"); assert.deepEqual(f.cache(), []);
    assert.equal(f.rows().length, mode === "all-quota" || mode === "invalid" ? 2 : 1);
  });
}

test("explicit budget survives fallback without resetting at the second route", t => {
  const f = fixture(t, "deadline"); failure(f.run({ ...f.request, ids: ["first", "second"], budgetMs: 1600, sources: { FIRST_REF: firstKey, SECOND_REF: secondKey } }), "review_incomplete");
  assert.deepEqual(f.rows().map(row => row.model), ["first", "second"]); assert.deepEqual(f.cache(), []);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`machine review ${signal} drains descendant groups and never publishes partial state`, { timeout: 15000 }, async t => {
    const f = fixture(t, "cancel"), child = spawn(process.execPath, f.args, { env: f.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += String(chunk)); child.stderr.on("data", chunk => stderr += String(chunk));
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
    t.after(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } } });
    child.stdin.end(JSON.stringify(f.request));
    const descendant = path.join(f.root, "descendant.json");
    for (let i = 0; i < 150 && !existsSync(descendant); i++) await delay(20);
    assert.equal(existsSync(descendant), true, stderr);
    const row = JSON.parse(readFileSync(descendant, "utf8")); assert.ok(child.pid); process.kill(child.pid, signal);
    assert.equal(await exit, signal === "SIGINT" ? 130 : 143, stderr);
    for (let i = 0; i < 100 && alive(-row.pg); i++) await delay(20);
    assert.equal(alive(-row.pg), false); assert.equal(alive(row.child), false);
    assert.equal(stdout.includes('"verdict":"pass"'), false); assert.deepEqual(f.cache(), []);
    assert.deepEqual(readdirSync(f.managed).filter(name => name.startsWith("needlefish")), []);
  });
}
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }


test("safe singleton ACP retains the existing result without auth or provider identity claims", t => {
  const f = fixture(t, "safe", "acp"), result = f.run();
  assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
  assert.equal(output.summary, "first clean"); assert.equal(output.verdict, "pass");
  assert.deepEqual(output.runtime.model, { status: "unknown" }); assert.deepEqual(output.runtime.qualification, { matchStatus: "unqualified" });
  assert.equal(output.rawOutputs, undefined); assert.equal(output.failedRawOutputs, undefined);
  assert.deepEqual(f.rows().map(row => [row.model, row.stage, row.keyMatches]), [["first", "review", true], ["first", "critic", true]]);
});

test("machine stdin rejects duplicate encoded references, invalid JSON and byte overflow without echo", t => {
  const f = fixture(t), text = JSON.stringify(f.request);
  failure(f.runRaw(text.replace('"sources":{', '"sources":{"FIRST_REF":"fake-unused",')), "invalid_request");
  failure(f.runRaw(text.replace('"sources":{', '"sources":{"\\u0046IRST_REF":"fake-unused",')), "invalid_request");
  failure(f.runRaw('{"fake-private-invalid-json'), "invalid_request");
  failure(f.runRaw("x".repeat(131073)), "input_too_large");
  assert.deepEqual(f.rows(), []); assert.deepEqual(f.cache(), []);
});

test("machine stdin timeout and cancellation emit only canned errors", { timeout: 15000 }, async t => {
  const f = fixture(t);
  for (const signal of [undefined, "SIGINT", "SIGTERM"] as const) {
    const child = spawn(process.execPath, f.args, { env: f.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += String(chunk)); child.stderr.on("data", chunk => stderr += String(chunk));
    const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
    t.after(() => { if (child.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; } } });
    child.stdin.write('{"private":"fake-not-finished');
    if (signal) { await delay(250); assert.ok(child.pid); process.kill(child.pid, signal); }
    assert.equal(await exit, 1, stderr); assert.equal(stderr, "");
    assert.deepEqual(JSON.parse(stdout), { schemaVersion: 1, ok: false, code: signal ? "cancelled" : "input_timeout" });
    assert.ok(child.pid); assert.equal(alive(-child.pid), false);
  }
  assert.deepEqual(f.rows(), []); assert.deepEqual(f.cache(), []);
});

test("closed machine stdout fails without an unhandled EPIPE diagnostic", { timeout: 10000 }, async t => {
  const f = fixture(t), child = spawn(process.execPath, f.args, { env: f.env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = ""; child.stderr.on("data", chunk => stderr += String(chunk));
  const exit = new Promise<number | null>(resolve => child.once("exit", resolve));
  child.stdout.destroy(); child.stdin.end("invalid-fake-private-json");
  assert.equal(await exit, 1); assert.equal(stderr, ""); assert.deepEqual(f.rows(), []); assert.deepEqual(f.cache(), []);
});

for (const value of ["", " leading-fake-value", "fake-value\0tail"]) {
  test(`invalid session credential never borrows the configured ambient source (${value.length})`, t => {
    const f = fixture(t); failure(f.run({ ...f.request, sources: { FIRST_REF: value } }), "review_incomplete");
    assert.deepEqual(f.rows(), []); assert.deepEqual(f.cache(), []);
  });
}

test("session direct auth preserves ambient proxy conflict checks without leaking the request", t => {
  const f = fixture(t);
  failure(f.run(f.request, { CODEX_PROXY_BASE_URL: "https://proxy.invalid/v1", CODEX_PROXY_API_KEY: "fake-ambient-proxy-value" }), "review_incomplete");
  assert.deepEqual(f.rows(), []); assert.deepEqual(f.cache(), []);
});

test("machine route order follows the request and does not launch an unused missing source", t => {
  const f = fixture(t);
  const result = f.run({ ...f.request, ids: ["second"], sources: { SECOND_REF: secondKey } });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).summary, "second clean");
  assert.deepEqual(f.rows().map(row => [row.model, row.stage, row.keyMatches]), [["second", "review", true], ["second", "critic", true]]);
});

for (const mode of ["safe", "leak"]) {
  test(`machine traced ACP ${mode} retains private-trace safety without public transcripts`, t => {
    const f = fixture(t, mode, "acp"), result = f.run(f.request, { NEEDLEFISH_EVAL_TRACE: "1" });
    if (mode === "leak") { failure(result, "review_incomplete"); assert.deepEqual(f.cache(), []); }
    else {
      assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
      assert.equal(output.summary, "first clean"); assert.equal(output.verdict, "pass");
      assert.equal(output.traceDeliveryFailed, true); assert.equal(output.rawOutputs, undefined); assert.equal(output.failedRawOutputs, undefined);
      assert.equal(result.stdout.includes(firstKey), false); assert.deepEqual(JSON.parse(readFileSync(f.cache()[0], "utf8")), output);
    }
  });
}

for (const kind of ["docs", "binary"] as const) {
  for (const credentialMode of ["existing", "session"] as const) {
    test(`${kind}-only session ingress skips missing credentials and source capture (${credentialMode})`, t => {
      const f = fixture(t);
      writeFileSync(path.join(f.repo, "app.ts"), "export const value = 1;\n");
      writeFileSync(path.join(f.repo, kind === "docs" ? "README.md" : "image.bin"), kind === "docs" ? "Updated docs\n" : Buffer.from([0, 1, 2]));
      const result = f.run({ ...f.request, credentialMode, sources: credentialMode === "session" ? { FIRST_REF: "" } : {} }, { FIRST_REF: "" });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const output = JSON.parse(result.stdout);
      assert.equal(output.verdict, "pass");
      assert.equal(output.docsOnlyFastPath, kind === "docs" ? true : undefined);
      assert.deepEqual(f.rows(), []);
      assert.deepEqual(existsSync(f.managed) ? readdirSync(f.managed).filter(name => name !== ".needlefish-sweep.lock") : [], []);
      assert.equal(f.cache().length, 1);
    });
  }
}
