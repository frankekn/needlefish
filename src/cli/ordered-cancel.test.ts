import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  test(`ordered CLI ${signal} drains every runner process group without starting fallback`, {timeout:15000}, async(t)=>{
    const root=mkdtempSync(path.join(os.tmpdir(),"needlefish-ordered-cancel-")),repo=initRepo(root);
    const managed=path.join(root,"managed"),home=path.join(root,"home"),config=path.join(root,"connections.json"),records=path.join(root,"runner.json"),bin=path.join(root,"codex.cjs");
    mkdirSync(home);gitText(["branch","-M","main"],repo);gitText(["checkout","-b","feature"],repo);
    writeFileSync(path.join(repo,"app.ts"),"export const value=1;\n");commitAll(repo,"feature");
    writeFileSync(config,JSON.stringify({version:1,connections:[{id:"first",adapter:"codex",model:"first"},{id:"second",adapter:"codex",model:"second"}]}));
    writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const child=cp.spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});
fs.writeFileSync(${JSON.stringify(records)},JSON.stringify({pg:process.pid,child:child.pid,model:process.argv[process.argv.indexOf('-m')+1]}));
setInterval(()=>{},1000);
`);chmodSync(bin,0o755);
    const env={...process.env,HOME:home,CODEX_BIN:bin,NEEDLEFISH_CONNECTIONS_FILE:config,NEEDLEFISH_TMPDIR:managed,NEEDLEFISH_REVIEW_TIMEOUT_MS:"10000",NEEDLEFISH_TERMINATION_GRACE_MS:"300",NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS:"30",NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS:"50",NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS:"100"};
    const cli=spawn(process.execPath,["--import","tsx",path.resolve("src/cli.ts"),"--repo",repo,"--connection=first","--connection=second"],{env,detached:true,stdio:["ignore","pipe","pipe"]});
    let stderr="";cli.stderr.on("data",chunk=>stderr+=String(chunk));cli.stdout.resume();
    const exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>(resolve=>cli.once("exit",(code,signal)=>resolve({code,signal})));
    t.after(()=>{
      const groups=[cli.pid];
      if(existsSync(records)){const row=JSON.parse(readFileSync(records,"utf8"));groups.push(row.pg);}
      for(const pg of groups) if(pg!==undefined) try{process.kill(-pg,"SIGKILL");}catch(error){if(!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;}
      rmSync(root,{recursive:true,force:true});
    });
    for(let i=0;i<100&&!existsSync(records);i++)await delay(30);
    assert.ok(existsSync(records),stderr);
    const row: {pg:number;child:number;model:string}=JSON.parse(readFileSync(records,"utf8"));
    assert.equal(row.model,"first");assert.ok(cli.pid);
    process.kill(cli.pid,signal);
    const outcome=await exit;
    assert.equal(outcome.code,signal === "SIGINT"?130:143,stderr);
    assert.equal(outcome.signal,null);
    for(let i=0;i<100&&groupAlive(row.pg);i++)await delay(20);
    assert.equal(groupAlive(row.pg),false,"runner group must be gone after CLI termination");
    assert.equal(processAlive(row.child),false,"runner grandchild must be gone");
    assert.equal(JSON.parse(readFileSync(records,"utf8")).model,"first");
    assert.deepEqual(readdirSync(managed).filter(name=>name.startsWith("needlefish")),[]);
  });
}
function groupAlive(pg:number):boolean{try{process.kill(-pg,0);return true;}catch{return false;}}
function processAlive(pid:number):boolean{try{process.kill(pid,0);return true;}catch{return false;}}
