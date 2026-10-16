import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GITHUB_WORKFLOW } from "./github.js";

function fixture(t: TestContext, initial: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "nf-guided-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state.json"), calls = join(root, "calls.jsonl");
  writeFileSync(state, JSON.stringify({ admin: true, actions: true, ...initial }));
  writeFileSync(join(root, "template"), GITHUB_WORKFLOW);
  const script = `#!${process.execPath}
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
const root=${JSON.stringify(root)};
const statePath=root+'/state.json';
const state=JSON.parse(readFileSync(statePath,'utf8'));
const args=process.argv.slice(2);
const input=readFileSync(0,'utf8');
appendFileSync(root+'/calls.jsonl',JSON.stringify({args,input})+'\\n');
const template=readFileSync(root+'/template','utf8');
function save(){writeFileSync(statePath,JSON.stringify(state))}
function out(value){console.log(JSON.stringify(value));process.exit(0)}
function missing(){console.error('gh: Not Found (HTTP 404)');process.exit(1)}
if(state.fail||(state.failSecret&&args[0]==='secret')){console.error('network failed '+input);process.exit(1)}
if(args[0]==='auth')process.exit(state.authFailed?1:0);
if(args[0]==='secret'){state.secret=true;save();process.exit(0)}
const endpoint=args.find(arg=>arg.startsWith('repos/')||arg.startsWith('user/repos'));
const body=input?JSON.parse(input):{};
if(endpoint.startsWith('user/repos'))out([[{full_name:'owner/repo',archived:false,permissions:{admin:true},private:true},{full_name:'owner/read',archived:false,permissions:{admin:false}}]]);
if(endpoint==='repos/owner/repo')out({default_branch:'main',permissions:{admin:state.admin}});
if(endpoint.endsWith('/actions/permissions'))out({enabled:state.actions});
if(endpoint.includes('/actions/secrets/')){if(state.secret)out({name:'NEEDLEFISH_CODEX_API_KEY'});missing()}
if(endpoint.includes('/contents/.github/workflows/needlefish.yml')){
  const branch=endpoint.includes('ref=needlefish');
  const content=branch?(state.branch?template:null):(state.modified?'# human edits':state.merged?template:null);
  if(content===null)missing();
  out({type:'file',encoding:'base64',sha:'file-sha',content:Buffer.from(content).toString('base64')})
}
if(endpoint.includes('/contents/.github/workflows?'))out(state.duplicate?[{name:'custom.yml',type:'file'}]:[]);
if(endpoint.includes('/contents/.github/workflows/custom.yml'))out({encoding:'base64',content:Buffer.from('uses: frankekn/needlefish@custom').toString('base64')});
if(endpoint.includes('/pulls?'))out(state.pr?[{body:'<!-- Needlefish setup template 1 -->',html_url:'https://github.com/owner/repo/pull/7'}]:[]);
if(endpoint.endsWith('/git/ref/heads/needlefish/setup-v1')){if(state.branch)out({object:{sha:'setup-sha'}});missing()}
if(endpoint.endsWith('/git/ref/heads/main'))out({object:{sha:'base-sha'}});
if(endpoint.endsWith('/git/commits/base-sha'))out({tree:{sha:'base-tree'}});
if(endpoint.endsWith('/git/commits/setup-sha'))out({message:state.unowned?'human commit':'Needlefish setup template 1'});
if(endpoint.includes('/compare/'))out({total_commits:1,files:state.extra?[{filename:'.github/workflows/needlefish.yml'},{filename:'README.md'}]:[{filename:'.github/workflows/needlefish.yml'}]});
if(endpoint.endsWith('/git/trees')){if(body.base_tree!=='base-tree'||body.tree.length!==1||body.tree[0].content!==template)throw Error('unexpected tree');out({sha:'setup-tree'})}
if(endpoint.endsWith('/git/commits'))out({sha:'setup-sha'});
if(endpoint.endsWith('/git/refs')){state.branch=true;save();out({ref:body.ref})}
if(endpoint.endsWith('/pulls')){state.pr=true;save();out({html_url:'https://github.com/owner/repo/pull/7'})}
throw Error('unhandled endpoint '+endpoint);
`;
  writeFileSync(join(root, "gh"), script); chmodSync(join(root, "gh"), 0o700);
  const run = (args: string[], input = "") => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "setup", "github", ...args], {
    encoding: "utf8", input, timeout: 20_000, env: { ...process.env, PATH: root + ":" + process.env.PATH },
  });
  const history = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { args: string[]; input: string });
  return { root, run, history, state: () => JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown> };
}
const remote = ["--repository", "owner/repo", "--json"];

test("guided CLI lists only administered repositories without mutations", t => {
  const f = fixture(t);
  const result = f.run(["repositories", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).repositories, [{ name: "owner/repo", private: true }]);
  assert.ok(f.history().every(call => !call.args.includes("--method")));
});

test("preview distinguishes absent config and secret from authentication and review evidence", t => {
  const f = fixture(t);
  const result = f.run(["status", ...remote]);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.phase, "preview"); assert.equal(status.secret, "missing");
  assert.equal(status.authentication, "unknown"); assert.equal(status.firstReview, "not_verified");
  assert.equal(status.workflow, GITHUB_WORKFLOW);
  assert.ok(f.history().every(call => !call.args.includes("--method")));
});

test("setup PR creation reconciles the owned branch and PR on repeated execution", t => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    const result = f.run(["create-pr", ...remote, "--confirm"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).phase, "pr_created");
    assert.equal(JSON.parse(result.stdout).prUrl, "https://github.com/owner/repo/pull/7");
  }
  const writes = f.history().filter(call => call.args.includes("--method"));
  assert.equal(writes.length, 4);
  assert.ok(writes.every(call => !call.args.includes("PATCH") && !call.args.some(arg => arg.includes("protection"))));
  assert.equal(JSON.parse(writes[2]!.input).ref, "refs/heads/needlefish/setup-v1");
});

test("a crash after branch creation reuses the exact owned branch", t => {
  const f = fixture(t, { branch: true });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.history().filter(call => call.args.includes("--method")).length, 1);
});

for (const state of [{ modified: true }, { duplicate: true }, { admin: false }, { actions: false }, { branch: true, unowned: true }, { branch: true, extra: true }]) {
  test(`setup preserves repository state when preflight rejects ${JSON.stringify(state)}`, t => {
    const f = fixture(t, state);
    const result = f.run(["create-pr", ...remote, "--confirm"]);
    assert.equal(result.status, 1);
    assert.ok(f.history().every(call => !call.args.includes("--method")));
  });
}

test("merged exact workflow remains merged without creating a new branch or PR", t => {
  const f = fixture(t, { merged: true, secret: true });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.phase, "merged"); assert.equal(status.secret, "present"); assert.equal(status.authentication, "unknown");
  assert.ok(f.history().every(call => !call.args.includes("--method")));
});

test("mutations need separate explicit confirmation", t => {
  const f = fixture(t);
  assert.equal(f.run(["create-pr", ...remote]).status, 1);
  assert.equal(f.run(["set-secret", ...remote], "fake-credential").status, 1);
  assert.equal(f.run(["login"]).status, 1);
  assert.ok(f.history().every(call => !call.args.includes("--method") && call.args[0] !== "secret"));
});

test("secret travels only through stdin and cannot silently replace existing metadata", t => {
  const f = fixture(t, { secret: true });
  const credential = "controlled-placeholder-credential";
  const refused = f.run(["set-secret", ...remote, "--confirm"], credential);
  assert.equal(refused.status, 1); assert.match(JSON.parse(refused.stdout).message, /--replace-secret/);
  assert.ok(f.history().every(call => call.args[0] !== "secret"));
  const success = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], credential);
  assert.equal(success.status, 0, success.stderr);
  assert.ok(!success.stdout.includes(credential) && !success.stderr.includes(credential));
  const writes = f.history().filter(call => call.args[0] === "secret");
  assert.deepEqual(writes, [{ args: ["secret", "set", "NEEDLEFISH_CODEX_API_KEY", "--repo", "owner/repo"], input: credential }]);
  assert.equal(JSON.parse(success.stdout).authentication, "unknown");
});

test("invalid credential input and network/auth failures do not produce false success or raw output", t => {
  const f = fixture(t);
  const result = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], "bad\ncredential");
  assert.equal(result.status, 1); assert.ok(f.history().every(call => call.args[0] !== "secret"));
  const broken = fixture(t, { fail: true });
  const failed = broken.run(["status", ...remote]);
  assert.equal(failed.status, 1); assert.match(JSON.parse(failed.stdout).message, /GitHub request failed/); assert.equal(JSON.parse(failed.stdout).phase, "error"); assert.equal(failed.stderr, "");
  const signedOut = fixture(t, { authFailed: true });
  assert.equal(signedOut.run(["status", ...remote]).status, 1);
});


test("secret tool failure cannot echo credential in public output", t => {
  const f = fixture(t, { failSecret: true });
  const credential = "controlled-failure-secret";
  const result = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], credential);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes(credential) && !result.stderr.includes(credential));
});

test("official browser login is an explicitly separate gh operation", t => {
  const f = fixture(t);
  const result = f.run(["login", "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, "signed_in");
  assert.deepEqual(f.history(), [{ args: ["auth", "login", "--hostname", "github.com", "--web", "--scopes", "workflow", "--git-protocol", "https", "--skip-ssh-key"], input: "" }]);
});


test("secret creation also requires explicit replace consent because GitHub has no create-only secret API", t => {
  const f = fixture(t);
  const result = f.run(["set-secret", ...remote, "--confirm"], "controlled-placeholder");
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /concurrently/);
  assert.ok(f.history().every(call => call.args[0] !== "secret"));
});


test("misplaced credential arguments are rejected without echo", t => {
  const f = fixture(t);
  const credential = "controlled-misplaced-credential";
  const result = f.run(["set-secret", ...remote, "--confirm", credential]);
  assert.equal(result.status, 1);
  assert.ok(!result.stdout.includes(credential) && !result.stderr.includes(credential));
  assert.match(result.stderr, /only through stdin/);
});
