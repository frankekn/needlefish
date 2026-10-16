import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffBundle } from "../adapters/local.js";
import { initRepo, commitAll } from "../shared/codex-runner-test-fixtures.js";
import { CodexEnvironmentAuth } from "../shared/connection-auth.js";
import { findRunnerFailure } from "../shared/runner-failure.js";
import { review, reviewWithConnections } from "./review.js";

for (const stage of ["review", "critic", "map", "deep"]) {
  test(`ordered ${stage} quota restarts whole review from one captured source`, async (t) => {
    const f = fixture(t, stage);
    const events: number[] = [];
    const result = await reviewWithConnections(f.bundle, [{runner:"codex",model:"first"},{runner:"codex",model:"second"}], e => { events.push(e.routeIndex ?? -1); });
    assert.equal(result.verdict, "pass");
    assert.equal(result.summary, stage === "map" || stage === "deep" ? "mapped \u2014 second clean" : "second clean");
    assert.deepEqual(result.findings, []);
    assert.ok(result.stats?.every(stat => stat.model === "second"));
    assert.deepEqual([...new Set(events)], [0,1]);
    const rows = f.rows();
    assert.ok(rows.some(row => row.model === "first" && row.stage === stage));
    assert.deepEqual(rows.filter(row=>row.model === "second").map(row=>row.stage), stage === "map" || stage === "deep" ? ["map","deep","critic"] : ["review","critic"]);
    assert.ok(rows.every(row => row.source === "export const value = 2;\n"));
    assert.equal(new Set(rows.map(row=>row.cwd)).size, rows.length);
    assert.ok(rows.every(row=>!existsSync(row.cwd)));
    assert.ok(rows.filter(row=>row.model === "second").every(row=>!row.contaminated));
    assert.equal(readFileSync(path.join(f.repo,"app.ts"),"utf8"),"source changed after quota\n");
    assert.deepEqual(readdirSync(f.managed).filter(name=>name.startsWith("needlefish")),[]);
  });
}

for (const mode of ["all-quota","auth","unknown","verdict","needs-human","blocking","cross-key","trace-fail"]) {
  test(`ordered review terminal control ${mode}`, async (t) => {
    const f=fixture(t,mode);
    const auth = (key: string) => new CodexEnvironmentAuth({CODEX_API_KEY:"SELECTED"}, {kind:"openai"}, {SELECTED:key});
    const routes = [{runner:"codex" as const, model:"first", ...(mode === "cross-key" ? {connectionAuth:auth("private-first-fixture")} : {})}, {runner:"codex" as const,model:"second", ...(mode === "cross-key" ? {connectionAuth:auth("private-second-fixture")} : {})}] as const;
    if (["all-quota","auth","unknown","cross-key"].includes(mode)) {
      await assert.rejects(reviewWithConnections(f.bundle,routes), e => {
        if(mode === "all-quota") assert.equal(findRunnerFailure(e)?.kind,"quota_exhausted");
        if(mode === "cross-key") assert.equal(findRunnerFailure(e)?.name,"ConnectionCredentialLeakError");
        return true;
      });
    } else {
      const result=await reviewWithConnections(f.bundle,routes,mode === "trace-fail" ? ()=>{throw Error("private observer unavailable");} : undefined);
      assert.equal(result.verdict, mode === "needs-human" ? "needs_human" : mode === "blocking" ? "changes_requested" : "pass");
      if(mode === "trace-fail") assert.equal(result.traceDeliveryFailed,true);
    }
    if (["auth","unknown","verdict","needs-human","blocking","cross-key"].includes(mode)) assert.ok(f.rows().every(row=>row.model === "first"));
  });
}

test("multiple routes require one explicit budget while singleton and docs-only retain behavior", async (t) => {
  const f=fixture(t,"verdict");
  delete process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS;
  await assert.rejects(reviewWithConnections(f.bundle,[{runner:"codex"},{runner:"codex"}]),/NEEDLEFISH_REVIEW_TIMEOUT_MS/);
  assert.equal(f.rows().length,0);
  assert.equal((await review(f.bundle,{runner:"codex",model:"first"})).verdict,"pass");
  process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS="invalid";
  assert.equal((await reviewWithConnections({...f.bundle,changedFiles:[{path:"README.md",surface:"docs"}]},[{runner:"codex"},{runner:"codex"}])).verdict,"pass");
});

test("later route cannot reset the shared deadline", async(t)=>{
  const f=fixture(t,"slow-quota");
  process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS="250";
  await assert.rejects(reviewWithConnections(f.bundle,[{runner:"codex",model:"first"},{runner:"codex",model:"second"}]),/deadline|timed out|ETIMEDOUT/);
  assert.ok(f.rows().length <= 2);
});

for (const failure of ["safety", "unknown", "auth", "timeout"]) {
  test(`deep quota cannot hide concurrent ${failure} and no queued pass begins`, async(t)=>{
    const f=fixture(t,`mixed-${failure}`);
    process.env.NEEDLEFISH_DEEP_CONCURRENCY="2";
    await assert.rejects(reviewWithConnections(f.bundle,[{runner:"codex",model:"first",timeoutMs:1500},{runner:"codex",model:"second"}]));
    const rows=f.rows();
    assert.ok(rows.every(row=>row.model === "first"));
    assert.equal(rows.filter(row=>row.stage === "deep").length,2);
  });
}

function fixture(t: import("node:test").TestContext, mode: string) {
  const tmp=mkdtempSync(path.join(os.tmpdir(),"needlefish-ordered-"));
  const previous={...process.env};
  t.after(()=>{process.env=previous;rmSync(tmp,{recursive:true,force:true});});
  const repo=initRepo(tmp);
  writeFileSync(path.join(repo,"app.ts"),"export const value = 1;\n");commitAll(repo,"base");
  writeFileSync(path.join(repo,"app.ts"),"export const value = 2;\n");
  const {bundle}=diffBundle(repo,{deep:["map","deep"].includes(mode) || mode.startsWith("mixed-")});
  const records=path.join(tmp,"records.jsonl"); const managed=path.join(tmp,"managed"); const bin=path.join(tmp,"codex.cjs");
  writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const prompt=fs.readFileSync(0,'utf8'),model=process.argv[process.argv.indexOf('-m')+1];
const repo=JSON.parse(prompt.slice('The repository to inspect is '.length,prompt.indexOf('. Your startup directory')));
const stage=prompt.includes('review-MAP pass')?'map':prompt.includes('doing a DEEP review')?'deep':prompt.includes('adversarial critic')?'critic':'review';
const source=fs.readFileSync(path.join(repo,'app.ts'),'utf8');
fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({model,stage,cwd:repo,source,contaminated:prompt.includes('first contaminated')})+'\\n');
const mode=${JSON.stringify(mode)};
if(mode==='cross-key'){process.stdout.write('private-second-fixture');process.exit(1);}
if((model==='first'&&(stage===mode||mode==='all-quota'||mode==='trace-fail'||mode==='slow-quota'))||mode==='all-quota'){
 fs.writeFileSync(${JSON.stringify(path.join(repo,"app.ts"))},'source changed after quota\\n');
 fs.rmSync(${JSON.stringify(path.join(repo,".git"))},{recursive:true,force:true});
 if(mode==='slow-quota')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,180);
 console.log(JSON.stringify({type:'turn.failed',error:{message:'insufficient credits'}}));process.exit(1);
}
if(mode.startsWith('mixed-')&&stage==='deep'){
 if(prompt.includes('"name": "quota"')){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,60);console.log(JSON.stringify({type:'turn.failed',error:{message:'insufficient credits'}}));process.exit(1);}
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,120);
 if(mode==='mixed-safety')fs.writeFileSync(path.join(repo,'app.ts'),'dirty');
 if(mode==='mixed-timeout')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20000);
 console.log(JSON.stringify({type:'turn.failed',error:{message:mode==='mixed-auth'?'401 unauthorized':'unknown failure'}}));process.exit(1);
}
if(mode==='auth'||mode==='unknown'){console.log(JSON.stringify({type:'turn.failed',error:{message:mode==='auth'?'401 unauthorized':'429 Too Many Requests'}}));process.exit(1);}
const finding={severity:'P2',title:'first contaminated',category:'bug',file:'app.ts',lineStart:1,lineEnd:1,confidence:0.9,whyItBreaks:'first contaminated',suggestedFix:'fix',validation:'test'};
const out=stage==='map'?{summary:'mapped',hotspots:mode.startsWith('mixed-')?['quota','sibling','queued'].map(name=>({name,files:['app.ts'],why:'changed',risk:'high',edges:[]})):[{name:'app',files:['app.ts'],why:'changed',risk:'high',edges:[]}]}:{summary:model==='second'?'second clean':'first contaminated',findings:mode==='blocking'?[finding]:[],checked:['FILES inspected=[app.ts]'],residual_risks:mode==='needs-human'?[{text:'unresolved',blocks:true}]:[]};
fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(out));
`);
  chmodSync(bin,0o755);
  Object.assign(process.env,{CODEX_BIN:bin,NEEDLEFISH_REVIEW_TIMEOUT_MS:"15000",NEEDLEFISH_NO_RETRY:"1",NEEDLEFISH_TMPDIR:managed});
  delete process.env.CODEX_PROXY_BASE_URL;delete process.env.CODEX_PROXY_API_KEY;delete process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED;
  return {bundle,repo,managed,rows:(): {model:string;stage:string;source:string;cwd:string;contaminated:boolean}[]=>existsSync(records)?readFileSync(records,"utf8").trim().split("\n").map(line=>JSON.parse(line)):[]};
}
