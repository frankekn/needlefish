import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffBundle } from "../adapters/local.js";
import { commitAll, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { AcpEnvironmentAuth } from "../shared/connection-auth.js";
import { ConnectionCredentialLeakError } from "../shared/runner-failure.js";
import { reviewWithConnections } from "./review.js";

for (const mode of ["success-stdout","success-stderr","failed-stdout","failed-stderr","structured","mixed","safe","replacement-safe"]) {
  test(`ordered ACP aggregate guard ${mode} retains private evidence`,async(t)=>{
    const root=mkdtempSync(path.join(os.tmpdir(),"needlefish-ordered-acp-")),repo=initRepo(root),bin=path.join(root,"agent.cjs"),log=path.join(root,"calls");
    const previous={...process.env};t.after(()=>{process.env=previous;rmSync(root,{recursive:true,force:true});});
    writeFileSync(path.join(repo,"app.ts"),"export const value=1;\n");commitAll(repo,"base");writeFileSync(path.join(repo,"app.ts"),"export const value=2;\n");
    const {bundle}=diffBundle(repo,{});
    const credential=mode === "replacement-safe"?"A�B-fixture":"acp-selected-%41-fixture";
    const encoded=Array.from(Buffer.from(credential)).map(byte=>'%'+byte.toString(16).padStart(2,'0')).join('');
    const mixed=Array.from(credential).map((char,index)=>index%2===0?char:Array.from(Buffer.from(char)).map(byte=>'%'+byte.toString(16).padStart(2,'0')).join('')).join('');
    const text=mode === "safe"?"https://debug.invalid/safe%2Fv1 bad%zz%ff":mode === "replacement-safe"?"A%ffB-fixture bad%zz":mode === "mixed"?mixed:encoded;
    writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),rl=require('node:readline');
fs.appendFileSync(${JSON.stringify(log)},'run\\n');
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
rl.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1,agentCapabilities:{}}});
if(m.method==='session/new')send({id:m.id,result:{sessionId:'s'}});
if(m.method==='session/prompt'){
 const mode=${JSON.stringify(mode)},text=${JSON.stringify(text)};
 if(mode.endsWith('stderr'))process.stderr.write(text+'\\n');
 if(mode.endsWith('stdout'))send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text}}}});
 if(mode.startsWith('failed-')){process.stdout.write('',()=>process.exit(1));return;}
 const summary=['structured','mixed','safe','replacement-safe'].includes(mode)?text:'safe completed';
 send({method:'session/update',params:{sessionId:'s',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({summary,...(m.params.prompt[0].text.includes('adversarial critic')?{decisions:[]}:{findings:[]}),checked:['app.ts'],residual_risks:[]})}}}});
 send({id:m.id,result:{stopReason:'end_turn'}});
}});
`);chmodSync(bin,0o755);
    Object.assign(process.env,{NEEDLEFISH_REVIEW_TIMEOUT_MS:"10000",NEEDLEFISH_EVAL_TRACE:"1",NEEDLEFISH_NO_RETRY:"0",NEEDLEFISH_RETRY_MS:"1"});
    delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
    const auth=new AcpEnvironmentAuth({AGENT_API_KEY:"SELECTED"},{SELECTED:credential}),traces:string[]=[];
    const route={runner:"acp" as const,acpLaunch:{command:bin,args:[]},connectionAuth:auth};
    if(mode === "safe"||mode === "replacement-safe"){
      const result=await reviewWithConnections(bundle,[route,route],e=>{traces.push(e.content);});
      assert.equal(result.summary,text);assert.equal(result.verdict,"pass");
      assert.equal(result.rawOutputs,undefined);assert.equal(result.failedRawOutputs,undefined);
    }else{
      await assert.rejects(reviewWithConnections(bundle,[route,route],e=>{traces.push(e.content);}),ConnectionCredentialLeakError);
      assert.equal(readFileSync(log,"utf8").trim().split("\n").length,1);
      assert.ok(traces.some(raw=>raw.includes(text)),"private trace keeps original encoded bytes");
    }
    assert.ok(existsSync(log));
  });
}
