import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { GITHUB_WORKFLOW, PREVIOUS_GITHUB_WORKFLOW } from "./github.js";

function fixture(t: TestContext, initial: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "nf-guided-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, "state.json"), calls = join(root, "calls.jsonl");
  writeFileSync(state, JSON.stringify({ admin: true, actions: true, ...initial }));
  writeFileSync(join(root, "template"), GITHUB_WORKFLOW);
  writeFileSync(join(root, "previous-template"), PREVIOUS_GITHUB_WORKFLOW);
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
if(state.clockSteps){state.elapsedMs=(state.elapsedMs||0)+(state.clockSteps[args[0]==='secret'?'secret':args.find(arg=>arg.startsWith('repos/'))]||0);save()}
if(state.delayAt===args.find(arg=>arg.startsWith('repos/')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,200);
function out(value){console.log(JSON.stringify(value));process.exit(0)}
function missing(){console.error('gh: Not Found (HTTP 404)');process.exit(1)}
if(state.fail||(state.failSecret&&args[0]==='secret')){console.error('network failed '+input);process.exit(1)}
if(args[0]==='auth'){if(state.loginOutput&&args[1]==='login')console.log('First copy your one-time code: AB12-CD34');process.exit(state.authFailed?1:0)}
if(args[0]==='secret'){state.secret=true;save();process.exit(0)}
const endpoint=args.find(arg=>arg.startsWith('repos/')||arg.startsWith('user/repos'));
const body=input?JSON.parse(input):{};
if(endpoint.startsWith('user/repos'))out([[{full_name:'owner/repo',archived:false,permissions:{admin:true},private:true},{full_name:'owner/read',archived:false,permissions:{admin:false}}]]);
if(endpoint.toLowerCase()==='repos/owner/repo')out({full_name:'owner/repo',default_branch:'main',permissions:{admin:state.admin}});
if(endpoint.endsWith('/actions/permissions'))out({enabled:state.actions,allowed_actions:state.policy||'all'});
if(endpoint.endsWith('/actions/permissions/selected-actions'))out({github_owned_allowed:state.githubOwned===true,verified_allowed:false,patterns_allowed:state.patterns||[]});
if(endpoint.startsWith('repos/frankekn/needlefish/contents/action.yml'))out({encoding:'base64',content:Buffer.from('runs:\\n  steps:\\n    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1').toString('base64')});
if(endpoint.includes('/actions/secrets/')){if(state.secret)out({name:'NEEDLEFISH_CODEX_API_KEY'});missing()}
if(endpoint.includes('/contents/.github/workflows/needlefish.yml')){
  const branch=endpoint.includes('ref=needlefish')||endpoint.includes('ref=setup-sha');
  const parent=endpoint.endsWith('ref=base-sha');
  const parentContent=state.parentWorkflow==='custom'?'# concurrent human edits':state.parentWorkflow==='previous'?readFileSync(root+'/previous-template','utf8'):state.parentWorkflow==='current'?template:null;
  const content=branch?(state.branch?(state.branchModified?'# human branch edits':template):null):parent&&state.parentWorkflow?parentContent:(state.modified?'# human edits':state.previous?readFileSync(root+'/previous-template','utf8'):state.merged?template:null);
  if(parent&&state.parentWorkflow==='unsupported')out({type:'file',encoding:'none',sha:'file-sha'});
  if(content===null)missing();
  out({type:'file',encoding:'base64',sha:'file-sha',content:Buffer.from(content).toString('base64')})
}
if(endpoint.includes('/contents/.github/workflows?'))out(endpoint.endsWith('ref=base-sha')&&state.parentDuplicate?[{name:'custom.yml',type:'file'}]:state.workflows|| (state.duplicate?[{name:'custom.yml',type:'file'}]:[]));
if(endpoint.includes('/contents/.github/workflows/slow'))out({encoding:'base64',content:Buffer.from('name: unrelated CI').toString('base64')});
if(endpoint.includes('/contents/.github/workflows/custom.yml'))out({encoding:'base64',content:Buffer.from('uses: frankekn/needlefish@custom').toString('base64')});
if(endpoint.includes('/pulls?'))out(state.pr?[{body:state.markerMissing?'manual PR':'<!-- Needlefish setup template 1 -->',html_url:'https://github.com/owner/repo/pull/7',base:{ref:state.wrongBase?'release':'main'},head:{ref:'needlefish/setup-v1',sha:state.staleHead?'stale-sha':'setup-sha',repo:{full_name:state.foreignHead?'other/repo':'owner/repo'}}}]:[]);
if(endpoint.endsWith('/git/ref/heads/needlefish/setup-v1')){if(state.branch){state.branchReads=(state.branchReads||0)+1;save();out({object:{sha:state.branchMoves&&state.branchReads>1?'moved-sha':'setup-sha'}})}missing()}
if(endpoint.endsWith('/git/ref/heads/main'))out({object:{sha:'base-sha'}});
if(endpoint.endsWith('/git/commits/base-sha'))out({tree:{sha:'base-tree'}});
if(endpoint.endsWith('/git/commits/setup-sha'))out({message:state.unowned?'human commit':'Needlefish setup template 1',parents:[{sha:'base-sha'}]});
if(state.merged&&endpoint.includes('/compare/main...'))out({total_commits:0,files:[]});
if(endpoint.includes('/compare/'))out({total_commits:1,files:state.extra?[{filename:'.github/workflows/needlefish.yml'},{filename:'README.md'}]:[{filename:'.github/workflows/needlefish.yml'}]});
if(endpoint.endsWith('/git/trees')){if(body.base_tree!=='base-tree'||body.tree.length!==1||body.tree[0].content!==template)throw Error('unexpected tree');out({sha:'setup-tree'})}
if(endpoint.endsWith('/git/commits'))out({sha:'setup-sha'});
if(endpoint.endsWith('/git/refs')){state.branch=true;save();out({ref:body.ref})}
if(endpoint.endsWith('/pulls')){state.pr=true;save();out({html_url:'https://github.com/owner/repo/pull/7'})}
throw Error('unhandled endpoint '+endpoint);
`;
  writeFileSync(join(root, "gh"), script); chmodSync(join(root, "gh"), 0o700);
  const clock = join(root, "clock.mjs");
  writeFileSync(clock, `import { readFileSync } from 'node:fs';
Object.defineProperty(performance, 'now', { value: () => JSON.parse(readFileSync(${JSON.stringify(state)}, 'utf8')).elapsedMs || 0 });`);
  const command = (args: string[]) => ["--import", clock, "--import", "tsx", "src/cli.ts", "setup", "github", ...args];
  const env = { ...process.env, PATH: root + ":" + process.env.PATH };
  const start = (args: string[]) => spawn(process.execPath, command(args), { env });
  const run = (args: string[], input = "") => spawnSync(process.execPath, command(args), {
    encoding: "utf8", input, timeout: 20_000, env,
  });
  const history = () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { args: string[]; input: string });
  return { root, run, start, history, state: () => JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown> };
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


for (const state of [{ unowned: true }, { extra: true }, { wrongBase: true }, { staleHead: true }, { foreignHead: true }, { markerMissing: true }, { branchModified: true }]) {
  test(`status withholds the setup PR link for unrecognized ownership ${JSON.stringify(state)}`, t => {
    const f = fixture(t, { branch: true, pr: true, ...state });
    const result = f.run(["status", ...remote]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).phase, "conflict");
    assert.equal(JSON.parse(result.stdout).prUrl, null);
    const refused = f.run(["create-pr", ...remote, "--confirm"]);
    assert.equal(refused.status, 1);
    assert.ok(f.history().every(call => !call.args.includes("--method")));
  });
}

for (const state of [
  { policy: "local_only" },
  { policy: "selected", patterns: ["actions/*"] },
  { policy: "selected", patterns: ["actions/checkout@*", "frankekn/needlefish@*"] },
  { policy: "selected", githubOwned: true, patterns: ["frankekn/*", "!frankekn/needlefish@*"] },
]) {
  test(`Actions policy rejects unavailable pinned dependencies ${JSON.stringify(state)}`, t => {
    const f = fixture(t, state);
    const result = f.run(["status", ...remote]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).actions, false);
    assert.equal(f.run(["create-pr", ...remote, "--confirm"]).status, 1);
    assert.ok(f.history().every(call => !call.args.includes("--method")));
  });
}

test("selected Actions policy supports explicit pinned references and GitHub-owned dependencies", t => {
  const f = fixture(t, { policy: "selected", githubOwned: true, patterns: ["frankekn/needlefish@7e5c4738eeac71c87be1766b3bb30fb82fc4706f"] });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).actions, true);
  assert.equal(JSON.parse(result.stdout).phase, "pr_created");
});

test("login progress goes to stderr while JSON status remains valid", t => {
  const f = fixture(t, { loginOutput: true });
  const result = f.run(["login", "--confirm", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, "signed_in");
  assert.match(result.stderr, /one-time code: AB12-CD34/);
});


test("the exact previous generated workflow receives one update PR while manual edits remain protected", t => {
  const f = fixture(t, { previous: true });
  const preview = f.run(["status", ...remote]);
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).phase, "preview");
  assert.equal(JSON.parse(preview.stdout).currentWorkflow, PREVIOUS_GITHUB_WORKFLOW);
  for (let index = 0; index < 2; index++) {
    const result = f.run(["create-pr", ...remote, "--confirm"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).phase, "pr_created");
  }
  assert.equal(f.history().filter(call => call.args.includes("--method")).length, 4);
});


for (const state of [{ modified: true }, { duplicate: true }, { branch: true, unowned: true }, { branch: true, extra: true }, { branch: true, pr: true, wrongBase: true }]) {
  test(`credential provisioning refuses conflicted setup before consuming stdin ${JSON.stringify(state)}`, t => {
    const f = fixture(t, state);
    const result = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], "controlled-never-sent-credential");
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).message, /Resolve the setup conflict/);
    assert.ok(f.history().every(call => call.args[0] !== "secret"));
    assert.ok(!result.stdout.includes("controlled-never-sent-credential"));
  });
}

test("a normally merged setup keeps its owned head branch without becoming conflicted", t => {
  const f = fixture(t, { merged: true, branch: true });
  const refreshed = f.run(["status", ...remote]);
  assert.equal(refreshed.status, 0, refreshed.stderr);
  assert.equal(JSON.parse(refreshed.stdout).phase, "merged");
  assert.equal(JSON.parse(refreshed.stdout).conflict, null);
  assert.equal(f.run(["create-pr", ...remote, "--confirm"]).status, 0);
  const secret = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], "controlled-placeholder");
  assert.equal(secret.status, 0, secret.stderr);
  assert.equal(JSON.parse(secret.stdout).phase, "merged");
  assert.ok(f.history().every(call => !call.args.includes("--method")));
});

test("repository case variants converge to the canonical setup PR", t => {
  const f = fixture(t);
  for (const repository of ["Owner/Repo", "OWNER/REPO"]) {
    const result = f.run(["create-pr", "--repository", repository, "--confirm", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).phase, "pr_created");
    assert.equal(JSON.parse(result.stdout).repository, "owner/repo");
  }
  assert.equal(f.history().filter(call => call.args.includes("--method")).length, 4);
});

for (const action of ["status", "create-pr", "set-secret"]) {
  test(`guided ${action} shares a deadline across successful slow workflow reads`, t => {
    const workflows = ["slow1.yml", "slow2.yml", "slow3.yml"].map(name => ({ name, type: "file" }));
    const clockSteps = Object.fromEntries(workflows.map(file => [`repos/owner/repo/contents/.github/workflows/${file.name}?ref=main`, 40_000]));
    const f = fixture(t, { workflows, clockSteps });
    const result = f.run([action, ...remote, ...(action === "status" ? [] : ["--confirm"]), ...(action === "set-secret" ? ["--replace-secret"] : [])], "controlled-deadline-placeholder");
    assert.equal(result.status, 1);
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.phase, "error");
    assert.match(failure.message, /setup.*deadline.*not completed/i);
    assert.ok(!result.stdout.includes("controlled-deadline-placeholder"));
    const calls = f.history();
    assert.equal(calls.filter(call => call.args.some(arg => arg.includes("/workflows/slow"))).length, 3);
    assert.ok(calls.every(call => !call.args.includes("--method") && call.args[0] !== "secret"));
    assert.ok(!calls.some(call => call.args.some(arg => arg.includes("/actions/secrets/"))));
  });
}

test("a gh call gets only the remaining operation budget", t => {
  const f = fixture(t, { clockSteps: { "repos/owner/repo": 104_950 }, delayAt: "repos/owner/repo/actions/permissions" });
  const result = f.run(["status", ...remote]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /setup.*deadline.*not completed/i);
  assert.ok(!f.history().some(call => call.args.some(arg => arg.includes("/contents/"))));
});

test("expired preflight budget prevents secret writes", t => {
  const f = fixture(t, { clockSteps: { "repos/owner/repo/git/ref/heads/needlefish/setup-v1": 105_000 } });
  const result = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], "controlled-deadline-placeholder");
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /setup.*deadline.*not completed/i);
  assert.ok(f.history().every(call => call.args[0] !== "secret"));
  assert.equal(f.state().secret, undefined);
});

test("deadline after an owned branch write reports incomplete and retry reuses it", t => {
  const f = fixture(t, { clockSteps: { "repos/owner/repo/git/refs": 105_000 } });
  const failed = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(failed.status, 1);
  assert.match(JSON.parse(failed.stdout).message, /setup.*deadline.*not completed/i);
  assert.equal(f.state().branch, true);
  assert.equal(f.state().pr, undefined);
  writeFileSync(join(f.root, "state.json"), JSON.stringify({ ...f.state(), clockSteps: {} }));
  const retry = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).phase, "pr_created");
  assert.equal(f.history().filter(call => call.args.includes("--method") && call.args.some(arg => arg.endsWith("/git/refs"))).length, 1);
});

test("a secret write that exhausts the budget cannot report success", t => {
  const f = fixture(t, { clockSteps: { secret: 105_000 } });
  const result = f.run(["set-secret", ...remote, "--confirm", "--replace-secret"], "controlled-deadline-placeholder");
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /setup.*deadline.*not completed/i);
  assert.equal(f.state().secret, true);
  assert.ok(!result.stdout.includes("controlled-deadline-placeholder"));
});

test("unrelated custom workflows are preserved and allow setup", t => {
  const f = fixture(t, { workflows: [{ name: "slow-ci.yml", type: "file" }] });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).phase, "pr_created");
  assert.deepEqual(f.state().workflows, [{ name: "slow-ci.yml", type: "file" }]);
});

test("setup PR mutation shares the budget spent on preflight", t => {
  const f = fixture(t, { clockSteps: {
    "repos/owner/repo/git/ref/heads/needlefish/setup-v1": 104_000,
    "repos/owner/repo/git/ref/heads/main": 1_001,
  } });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).message, /setup.*deadline.*not completed/i);
  assert.ok(f.history().every(call => !call.args.includes("--method")));
  assert.equal(f.state().branch, undefined);
});

test("credential stdin waiting shares the operation deadline", { timeout: 10_000 }, async t => {
  const f = fixture(t, { clockSteps: { "repos/owner/repo/git/ref/heads/needlefish/setup-v1": 104_950 } });
  const child = f.start(["set-secret", ...remote, "--confirm", "--replace-secret"]);
  t.after(() => child.kill());
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8").on("data", (data: string) => { stdout += data; });
  child.stderr.setEncoding("utf8").on("data", (data: string) => { stderr += data; });
  const status = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(status, 1, stderr);
  assert.match(JSON.parse(stdout).message, /setup.*deadline.*not completed/i);
  assert.ok(f.history().every(call => call.args[0] !== "secret"));
  assert.equal(f.state().secret, undefined);
});

for (const initial of [
  { parentWorkflow: "custom" },
  { parentWorkflow: "unsupported" },
  { parentDuplicate: true },
  { branch: true, parentWorkflow: "custom" },
  { branch: true, pr: true, parentWorkflow: "custom" },
]) {
  test(`setup validates the immutable parent before writes ${JSON.stringify(initial)}`, t => {
    const f = fixture(t, initial);
    const result = f.run(["create-pr", ...remote, "--confirm"]);
    assert.equal(result.status, 1, JSON.stringify({ stdout: result.stdout, calls: f.history() }));
    const failure = JSON.parse(result.stdout);
    assert.equal(failure.schemaVersion, 1);
    assert.equal(failure.phase, "error");
    assert.equal(failure.message, initial.pr
      ? "An existing setup PR has unrecognized ownership, contents or target branch. Inspect it before setup; it was not changed."
      : initial.parentDuplicate ? "Another workflow (custom.yml) already configures Needlefish. Ask its owner to reconcile it."
      : initial.parentWorkflow === "unsupported" ? "Existing workflow is not a supported regular file. Ask its owner to inspect it."
      : "Existing needlefish.yml differs from the known template. Preserve it and ask its owner to reconcile changes.");
    assert.deepEqual(f.history().filter(call => call.args.includes("--method")), []);
  });
}

test("setup preserves the previous template at the immutable parent", t => {
    const f = fixture(t, { parentWorkflow: "previous" });
    const result = f.run(["create-pr", ...remote, "--confirm"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).phase, "pr_created");
    const writes = f.history().filter(call => call.args.includes("--method"));
    assert.equal(writes.length, 4);
    assert.deepEqual(JSON.parse(writes[1]!.input).parents, ["base-sha"]);
    assert.ok(f.history().some(call => call.args.some(arg => arg.endsWith("needlefish.yml?ref=base-sha"))));
});

test("a moved owned branch is not reused after parent inspection", t => {
  const f = fixture(t, { branch: true, branchMoves: true });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1, phase: "error",
    message: "The setup branch changed during setup. No PR was created; inspect and retry.",
  });
  assert.deepEqual(f.history().filter(call => call.args.includes("--method")), []);
});

test("a concurrently installed current workflow creates no empty setup commit", t => {
  const f = fixture(t, { parentWorkflow: "current" });
  const result = f.run(["create-pr", ...remote, "--confirm"]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1, phase: "error",
    message: "The selected revision already contains the current setup workflow. Nothing was written. Refresh status before retrying.",
  });
  assert.deepEqual(f.history().filter(call => call.args.includes("--method")), []);
});
