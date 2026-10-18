import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { commitAll, gitText, headSha, initRepo } from "./codex-runner-test-fixtures.js";

const loader = createRequire(import.meta.url).resolve("tsx");
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const keyA = "TEST-ACCOUNT-A", keyB = "TEST-ACCOUNT-B";
const reviewJson = JSON.stringify({ summary: "Checked source", checked: ["source.ts"], findings: [], residual_risks: [] });

// Real child process and Git; only the external ACP agent is replaced.
function fixture(t: TestContext, mode = "success", credential = keyA) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-account-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = initRepo(root);
  writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
  commitAll(repo, "source base");
  const base = headSha(repo);
  writeFileSync(path.join(repo, "source.ts"), "export const value = 2;\n");
  commitAll(repo, "source change");
  const head = headSha(repo);
  const log = path.join(root, "agent.jsonl");
  const agent = path.join(root, "agent.cjs");
  writeFileSync(agent, `
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const readline = require('node:readline');
const [log, mode] = process.argv.slice(2);
const hash = value => crypto.createHash('sha256').update(value || '').digest('hex');
const prior = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\\n').length : 0;
const record = {
  key: hash(process.env.AGENT_API_KEY), cwd: process.cwd(), home: process.env.HOME,
  userprofile: process.env.USERPROFILE,
  xdg: ['XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME'].map(k => process.env[k]),
  leaked: ['ACCOUNT_A_KEY','ACCOUNT_B_KEY','GH_TOKEN','GITHUB_TOKEN','OPENAI_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'].filter(k => process.env[k] !== undefined),
  oldProfile: fs.existsSync(path.join(process.env.HOME, '.agent', 'auth.json')),
  proxy: process.env.HTTPS_PROXY, gitGlobal: process.env.GIT_CONFIG_GLOBAL,
  gitSystem: process.env.GIT_CONFIG_SYSTEM, gitNoSystem: process.env.GIT_CONFIG_NOSYSTEM,
  ghEmpty: fs.readdirSync(process.env.GH_CONFIG_DIR).length === 0,
  homeMode: fs.statSync(process.env.HOME).mode & 511
};
fs.appendFileSync(log, JSON.stringify(record) + '\\n');
// Writes must be disposable, not write through into either account's profile.
fs.writeFileSync(path.join(process.env.HOME, 'session-marker'), 'temporary');
const send = message => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...message}) + '\\n');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({id:request.id,result:{protocolVersion:1,agentCapabilities:{},authMethods:[]}});
  if (request.method === 'session/new') {
    if (mode === 'retry' && prior === 0) send({id:request.id,error:{code:-32603,message:'temporary server error'}});
    else send({id:request.id,result:{sessionId:'test-session'}});
  }
  if (request.method === 'session/prompt') {
    if (mode.startsWith('split-thought') && prior === 0) {
      const key = process.env.AGENT_API_KEY;
      for (const text of [key.slice(0,4),key.slice(4,8),key.slice(8)]) send({method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text}}}});
      if (mode === 'split-thought-failure') { process.stdout.write('', () => process.exit(1)); return; }
    }
    const map = JSON.stringify(request.params).includes('review-MAP pass');
    if (mode.startsWith('deep-') && !map && prior === 1) {
      if (mode === 'deep-nonzero-once') { process.stderr.write(process.env.AGENT_API_KEY, () => process.exit(1)); return; }
      process.stderr.write(process.env.AGENT_API_KEY + '\\n');
    }
    if (mode === 'prefixed-json-stderr') process.stderr.write('credential log ' + JSON.stringify(process.env.AGENT_API_KEY) + '\\n');
    if (mode === 'success-stderr-leak' || mode === 'success-stderr-leak-once' && prior === 0) process.stderr.write(process.env.AGENT_API_KEY + '\\n');
    if (mode === 'success-stdout-leak' || mode === 'success-stdout-leak-once' && prior === 0) send({method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'thought_message_chunk',content:{type:'text',text:process.env.AGENT_API_KEY}}}});
    if (mode === 'stderr-leak' || mode === 'stderr-leak-once' && prior === 0) {
      process.stderr.write('auth error code: ' + process.env.AGENT_API_KEY + '\\n', () => process.exit(1));
      return;
    }
    if (mode.startsWith('sandbox-leak')) {
      const escaped = Array.from(process.env.AGENT_API_KEY).map(c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
      const filename = mode === 'sandbox-leak-encoded' ? escaped : mode === 'sandbox-leak-double-encoded' ? JSON.stringify(escaped) : process.env.AGENT_API_KEY;
      fs.writeFileSync(path.join(process.cwd(), filename), 'temporary');
      process.stderr.write('sandbox filename: ' + process.env.AGENT_API_KEY + '\\n');
    }
    if (mode === 'auth-error') {
      send({id:request.id,error:{code:-32000,message:'auth rejected TEST-ACCOUNT-A'}});
    } else {
      let output = map ? JSON.stringify({summary:'mapped',hotspots:[{name:'source',files:['source.ts'],why:'changed',risk:'high',edges:[]}]}) : ${JSON.stringify(reviewJson)};
      if (mode === 'explain-json-escaped') output = 'Credential note ' + JSON.stringify(process.env.AGENT_API_KEY);
      if (mode.startsWith('explain-escaped')) {
        const escaped = Array.from(process.env.AGENT_API_KEY).map((c,i) => mode.endsWith('-mixed') && i % 2 === 0 ? c : '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
        output = 'Credential note ' + escaped;
      }
      if (mode === 'success-stdout-escaped') {
        const text = JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'thought_message_chunk',content:{type:'text',text:process.env.AGENT_API_KEY}}}});
        const escaped = Array.from(process.env.AGENT_API_KEY).map(c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
        process.stdout.write(text.replace(process.env.AGENT_API_KEY, escaped) + '\\n');
      }
      if (mode.startsWith('leak') && (!mode.endsWith('-once') || prior === 0)) {
        output = JSON.stringify({summary:process.env.AGENT_API_KEY,checked:['source.ts'],findings:[],residual_risks:[]});
        if (mode.startsWith('leak-fenced')) {
          const escaped = Array.from(process.env.AGENT_API_KEY).map(c => '\\\\u' + c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
          output = '\x60\x60\x60json\\n' + output.replace(process.env.AGENT_API_KEY, escaped) + '\\n\x60\x60\x60';
        }
      }
      send({method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:output}}}});
      send({id:request.id,result:{stopReason:'end_turn',usage:{totalTokens:3,inputTokens:2,outputTokens:1}}});
    }
  }
});
`);
  const config = path.join(root, "connections.json");
  writeFileSync(config, JSON.stringify({ version: 1, connections: ["a", "b"].map((id) => ({
    id, adapter: "acp", launch: { command: process.execPath, args: [agent, log, mode] },
    auth: { env: { AGENT_API_KEY: id === "a" ? "ACCOUNT_A_KEY" : "ACCOUNT_B_KEY" } },
  })) }));
  const home = path.join(root, "host-home");
  mkdirSync(path.join(home, ".agent"), { recursive: true });
  writeFileSync(path.join(home, ".agent", "auth.json"), "DEFAULT-ACCOUNT-MUST-NOT-BE-COPIED");
  const tmp = path.join(root, "tmp");
  mkdirSync(tmp);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:NEEDLEFISH_|CODEX_|CLAUDE_|OPENCODE_|PI_|GROK_|GIT_|GH_|GITHUB_|XDG_)/.test(name)) delete env[name];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, NEEDLEFISH_CONNECTIONS_FILE: config,
    NEEDLEFISH_TMPDIR: tmp, NEEDLEFISH_TIMEOUT_MS: "5000", NEEDLEFISH_RETRY_MS: "1",
    NEEDLEFISH_EPHEMERAL_HOME: "0", NEEDLEFISH_ACP_AUTH_FILES: ".agent/auth.json",
    ACCOUNT_A_KEY: credential, ACCOUNT_B_KEY: keyB, AGENT_API_KEY: "WRONG-DEFAULT",
    OPENAI_API_KEY: "UNRELATED-KEY", CLAUDE_CODE_OAUTH_TOKEN: "UNRELATED-TOKEN",
    GH_TOKEN: "TEST-GH-ORCHESTRATOR", GITHUB_TOKEN: "TEST-GITHUB-ORCHESTRATOR",
    HTTPS_PROXY: "http://proxy.example.invalid:8888",
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home,
  });
  function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
    const result = spawnSync(process.execPath, ["--import", loader, ...args], {
      env: { ...env, ...overrides }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    return result;
  }
  function records(): Record<string, unknown>[] {
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  }
  function clean() {
    assert.equal(headSha(repo), head);
    assert.equal(gitText(["status", "--porcelain"], repo), "");
    assert.equal(readFileSync(path.join(home, ".agent", "auth.json"), "utf8"), "DEFAULT-ACCOUNT-MUST-NOT-BE-COPIED");
    assert.equal(existsSync(path.join(home, "session-marker")), false);
    for (const record of records()) {
      assert.equal(existsSync(String(record.home)), false);
      assert.equal(existsSync(String(record.cwd)), false);
    }
  }
  return { root, repo, base, head, home, config, env, run, records, clean };
}

function harness(f: ReturnType<typeof fixture>, parallel: boolean): string {
  const file = path.join(f.root, "invoke.mjs");
  writeFileSync(file, `
import {runCodex,isRunnerSafetyError} from ${JSON.stringify(new URL("./codex.ts", import.meta.url).href)};
import {resolveConnectionOptions} from ${JSON.stringify(new URL("./connections.ts", import.meta.url).href)};
const repo = ${JSON.stringify(f.repo)}, head = ${JSON.stringify(f.head)};
const opts = ${parallel ? "['a','b']" : "['a']"}.map(connection => resolveConnectionOptions({connection,repoPath:repo,targetHeadSha:head},repo));
// Both real executions must retain selection-time values across concurrent calls and retries.
process.env.ACCOUNT_A_KEY = process.env.ACCOUNT_B_KEY = 'CHANGED-AFTER-SELECTION';
const hasCredential = raw => raw.includes(${JSON.stringify(f.env.ACCOUNT_A_KEY)}) || raw.includes(${JSON.stringify(Array.from(f.env.ACCOUNT_A_KEY ?? "").map(c => "\\u" + c.charCodeAt(0).toString(16).padStart(4,"0")).join(""))});
let sawFailedRaw = false;
let sawFailedAttemptRaw = false;
try {
  const results = await Promise.all(opts.map(opt => runCodex('Return review JSON', {...opt,
    onFailedRaw:raw => {sawFailedRaw ||= hasCredential(raw);},
    onFailedAttempt:(attempt,raw) => {sawFailedAttemptRaw ||= raw === undefined ? false : hasCredential(raw);}
  })));
  console.log(JSON.stringify({ok:true,count:results.length,globalUnchanged:process.env.ACCOUNT_A_KEY === 'CHANGED-AFTER-SELECTION'}));
} catch(error) {
  console.log(JSON.stringify({ok:false,message:error.message,name:error.name,safetyError:isRunnerSafetyError(error),sawFailedRaw,sawFailedAttemptRaw,...(error.cause ? {causeName:error.cause.name} : {})}));
  process.exitCode = 1;
}
`);
  return file;
}

function isolated(record: Record<string, unknown>, hostHome: string) {
  assert.deepEqual(record.leaked, []);
  assert.equal(record.oldProfile, false);
  assert.equal(record.userprofile, record.home);
  assert.notEqual(record.home, hostHome);
  assert.equal(record.ghEmpty, true);
  assert.equal(record.gitGlobal, "/dev/null");
  assert.equal(record.gitSystem, "/dev/null");
  assert.equal(record.gitNoSystem, "1");
  assert.equal(record.proxy, "http://proxy.example.invalid:8888");
  if (process.platform !== "win32") assert.equal(record.homeMode, 0o700);
  assert.ok(Array.isArray(record.xdg));
  for (const dir of record.xdg) assert.ok(String(dir).startsWith(String(record.home) + path.sep));
}

test("two ACP accounts run concurrently with separate frozen credentials and disposable roots", (t) => {
  const f = fixture(t);
  const result = f.run([harness(f, true)]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, count: 2, globalUnchanged: true });
  const records = f.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map((r) => r.key).sort(), [digest(keyA), digest(keyB)].sort());
  assert.notEqual(records[0].home, records[1].home);
  records.forEach((r) => isolated(r, f.home));
  f.clean();
});

test("retry keeps the selected credential after its source changes and cleans both attempts", (t) => {
  const f = fixture(t, "retry");
  const result = f.run([harness(f, false)]);
  assert.equal(result.status, 0, result.stderr);
  const records = f.records();
  assert.equal(records.length, 2);
  records.forEach((r) => { assert.equal(r.key, digest(keyA)); isolated(r, f.home); });
  assert.notEqual(records[0].home, records[1].home);
  f.clean();
});

test("structured auth failure does not retry or expose the key but retains controlled raw evidence", (t) => {
  const f = fixture(t, "auth-error");
  const result = f.run([harness(f, false)]);
  assert.equal(result.status, 1);
  const diagnostic = JSON.parse(result.stdout);
  assert.equal(diagnostic.ok, false);
  assert.equal(diagnostic.sawFailedRaw, true);
  assert.doesNotMatch(result.stdout + result.stderr, /TEST-ACCOUNT|WRONG-DEFAULT|UNRELATED/);
  assert.equal(f.records().length, 1);
  f.clean();
});

for (const mode of ["stderr-leak", "sandbox-leak", "sandbox-leak-encoded", "sandbox-leak-double-encoded"]) {
  const credential = "synthetic_secret_a1234567890";
  test(`${mode}: failure screening retains raw evidence and error classification after source mutation`, (t) => {
    const f = fixture(t, mode, credential);
    const result = f.run([harness(f, false)], { NEEDLEFISH_NO_RETRY: mode === "stderr-leak" ? "1" : "0" });
    assert.equal(result.status, 1);
    const diagnostic = JSON.parse(result.stdout);
    const sandbox = mode.startsWith("sandbox-leak");
    assert.match(diagnostic.message, /withheld.*credential/);
    if (sandbox) assert.equal(diagnostic.message, "Needlefish withheld runner diagnostic: the modified review sandbox may contain a selected connection credential. Use controlled raw diagnostics to inspect the change.");
    assert.equal(diagnostic.name, sandbox ? "RunnerWorktreeChangedError" : "ConnectionCredentialLeakError");
    assert.equal(diagnostic.safetyError, true);
    assert.equal(diagnostic.sawFailedRaw, true);
    assert.equal(diagnostic.sawFailedAttemptRaw, true);
    assert.ok(!(result.stdout + result.stderr).includes(credential));
    assert.equal(f.records().length, 1);
    f.clean();
  });

  test(`${mode}: local CLI withholds failure credentials and writes no cache`, (t) => {
    const f = fixture(t, mode, credential);
    const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"], { NEEDLEFISH_NO_RETRY: "1" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /withheld.*credential/);
    assert.ok(!result.stderr.includes(credential));
    assert.ok(!result.stderr.includes("\\u"));
    assert.equal(existsSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json")), false);
    f.clean();
  });
}

test("full CLI review and critic use one account without placing credentials in result or cache", (t) => {
  const f = fixture(t);
  const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdict, "pass");
  assert.equal(f.records().length, 2);
  f.records().forEach((r) => { assert.equal(r.key, digest(keyA)); isolated(r, f.home); });
  const cached = readFileSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json"), "utf8");
  assert.deepEqual(JSON.parse(cached), output);
  assert.doesNotMatch(result.stdout + result.stderr + cached, /TEST-ACCOUNT|ACCOUNT_A_KEY|connectionAuth/);
  f.clean();
});

for (const mode of ["leak", "leak-fenced"]) {
  test(`${mode}: selected credentials are withheld before result, cache or public diagnostics`, (t) => {
    const f = fixture(t, mode);
    const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /withheld.*credential/);
    assert.doesNotMatch(result.stdout + result.stderr, /TEST-ACCOUNT/);
    assert.equal(existsSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json")), false);
    f.clean();
  });

  test(`${mode}: screening uses the frozen credential after source mutation`, (t) => {
    const f = fixture(t, mode);
    const result = f.run([harness(f, false)]);
    assert.equal(result.status, 1);
    assert.match(JSON.parse(result.stdout).message, /withheld.*credential/);
    assert.doesNotMatch(result.stdout + result.stderr, /TEST-ACCOUNT/);
    f.clean();
  });
}

for (const mode of ["leak-fenced", "stderr-leak", "sandbox-leak", "sandbox-leak-encoded", "sandbox-leak-double-encoded", "success-stderr-leak", "success-stdout-leak", "success-stdout-escaped"]) {
  test(`GitHub never posts an echoed selected credential: ${mode}`, (t) => {
    const credential = mode === "leak-fenced" ? keyA : "synthetic_secret_a1234567890";
    const f = fixture(t, mode, credential);
    const bin = path.join(f.root, "bin");
    mkdirSync(bin);
    const writes = path.join(f.root, "github-writes.jsonl");
    const gh = path.join(bin, "gh");
    writeFileSync(gh, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('--input')) {
  fs.appendFileSync(${JSON.stringify(writes)}, fs.readFileSync(0,'utf8') + '\\n');
  process.stdout.write('{"id":1,"app":{"id":15368,"slug":"github-actions"}}');
} else if (args[1] === 'repos/frankekn/needlefish/pulls/7') {
  process.stdout.write(${JSON.stringify(JSON.stringify({ state: "open", author_association: "MEMBER", user: { login: "author", type: "User" }, head: { sha: f.head }, base: { sha: f.base } }))});
} else if (args[1] === 'user') process.stdout.write('{"login":"github-actions[bot]"}');
else if (args.some(a => a.includes('/check-runs?'))) process.stdout.write('[{"check_runs":[]}]');
else if (args.includes('--paginate')) process.stdout.write('[[]]');
else process.stdout.write('[]');
`);
    chmodSync(gh, 0o755);
    const result = f.run([cli, "--repo", f.repo, "--github", "--pr", "7", "--connection", "a"], {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "frankekn/needlefish",
      NEEDLEFISH_NO_RETRY: "1",
    });
    assert.equal(result.status, 1);
    const outbound = readFileSync(writes, "utf8");
    assert.match(outbound, /withheld.*credential/);
    assert.doesNotMatch(result.stdout + result.stderr + outbound, /TEST-ACCOUNT|\\u0054/);
    assert.ok(!(result.stdout + result.stderr + outbound).includes(credential));
    assert.ok(!(result.stdout + result.stderr + outbound).includes("\\u"));
    f.clean();
  });
}

test("dry-run validates auth configuration without requiring its credential", (t) => {
  const f = fixture(t);
  const args = [cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--dry-run", "--json"];
  const preview = f.run(args, { ACCOUNT_A_KEY: "" });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(f.records().length, 0);
  writeFileSync(f.config, '{"version":1,"connections":[{"id":"a","adapter":"acp","auth":{"env":{}}}]}');
  const invalid = f.run(args, { ACCOUNT_A_KEY: "" });
  assert.equal(invalid.status, 1);
  f.clean();
});

for (const [name, overrides, expected] of [
  ["missing account", { ACCOUNT_A_KEY: "" }, /no default account/],
  ["whitespace-wrapped account", { ACCOUNT_A_KEY: `${keyA}\n` }, /leading\/trailing whitespace.*no default account/],
  ["legacy routing passthrough", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "OPENAI_BASE_URL" }, /routing settings/],
] as const) {
  test(`CLI ${name} stops before any agent starts`, (t) => {
    const f = fixture(t);
    const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a"], overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /TEST-ACCOUNT|ACCOUNT_A_KEY/);
    assert.equal(f.records().length, 0);
    f.clean();
  });
}

for (const mode of ["success-stderr-leak", "success-stdout-leak", "success-stderr-leak-once", "success-stdout-leak-once", "leak-once", "leak-fenced-once", "stderr-leak-once"]) {
  test(`${mode}: successful transcript screening preserves private failed evidence`, (t) => {
    const f = fixture(t, mode);
    const result = f.run([harness(f, false)], { NEEDLEFISH_NO_RETRY: "0" });
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: false,
      message: "Needlefish withheld runner output: it contained a selected connection credential.",
      name: "ConnectionCredentialLeakError",
      safetyError: true,
      sawFailedRaw: true,
      sawFailedAttemptRaw: true,
      ...(mode === "stderr-leak-once" ? { causeName: "RunnerOperationalError" } : {}),
    });
    assert.equal(f.records().length, 1);
    f.clean();
  });

  test(`${mode}: trace-enabled CLI withholds successful transcript before result or cache`, (t) => {
    const f = fixture(t, mode);
    const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"], { NEEDLEFISH_EVAL_TRACE: "1", NEEDLEFISH_NO_RETRY: "0" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /withheld.*credential/);
    assert.doesNotMatch(result.stdout + result.stderr, /TEST-ACCOUNT|ACCOUNT_A_KEY/);
    assert.equal(existsSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json")), false);
    assert.equal(f.records().length, 1);
    f.clean();
  });
}

for (const mode of ["deep-raw-once", "deep-nonzero-once", "success-stdout-escaped"]) {
  test(`${mode}: credential rejection aborts trace-enabled review without retry or public result`, (t) => {
    const f = fixture(t, mode);
    const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"], {
      NEEDLEFISH_EVAL_TRACE: "1", NEEDLEFISH_NO_RETRY: "0",
      ...(mode.startsWith("deep-") ? { NEEDLEFISH_LARGE_PATCH_CHARS: "1" } : {}),
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /withheld.*credential/);
    assert.doesNotMatch(result.stdout + result.stderr, /TEST-ACCOUNT|ACCOUNT_A_KEY|\\u0054/);
    assert.equal(existsSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json")), false);
    assert.equal(f.records().length, mode.startsWith("deep-") ? 2 : 1);
    f.clean();
  });
}

for (const mode of ["explain-escaped", "explain-escaped-mixed", "explain-json-escaped"]) {
  test(`${mode}: plain explanation rejects literal Unicode escapes without retry`, (t) => {
    const f = fixture(t, mode, mode === "explain-json-escaped" ? "KEY\n\t\"\\tail" : keyA);
    const script = path.join(f.root, "explain.mjs");
    writeFileSync(script, `
import {explainFinding} from ${JSON.stringify(new URL("../core/explain.ts", import.meta.url).href)};
import {diffBundle} from ${JSON.stringify(new URL("../adapters/local.ts", import.meta.url).href)};
import {resolveConnectionOptions} from ${JSON.stringify(new URL("./connections.ts", import.meta.url).href)};
import {isRunnerSafetyError} from ${JSON.stringify(new URL("./runner-sandbox.ts", import.meta.url).href)};
const repo=${JSON.stringify(f.repo)};
const {bundle}=diffBundle(repo,{base:${JSON.stringify(f.base)},localMode:'branch'});
const opts=resolveConnectionOptions({connection:'a'},repo);
try { console.log(await explainFinding(bundle,'finding',opts)); }
catch(error) { console.error(JSON.stringify({message:error.message,safety:isRunnerSafetyError(error)})); process.exitCode=1; }
`);
    const result = f.run([script], { NEEDLEFISH_NO_RETRY:"0", NEEDLEFISH_EVAL_TRACE:"1" });
    assert.equal(result.status,1,result.stderr);
    assert.equal(result.stdout,"");
    assert.deepEqual(JSON.parse(result.stderr), {message:"Needlefish withheld runner output: it contained a selected connection credential.",safety:true});
    assert.equal(f.records().length,1);
    assert.equal(existsSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json")), false);
    f.clean();
  });
}

test("prefixed JSON credential log aborts trace-enabled output before retention", (t) => {
  const credential = "KEY\n\t\"\\tail";
  const f = fixture(t, "prefixed-json-stderr", credential);
  const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"], {NEEDLEFISH_EVAL_TRACE:"1",NEEDLEFISH_NO_RETRY:"0"});
  assert.equal(result.status,1,result.stderr);
  assert.equal(result.stdout,"");
  assert.match(result.stderr,/withheld.*credential/);
  assert.equal(f.records().length,1);
  assert.equal(existsSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json")), false);
  f.clean();
});

for (const mode of ["split-thought-success", "split-thought-failure"]) {
  test(`${mode}: authenticated trace keeps transcripts out of public result and cache`, (t) => {
    const f = fixture(t, mode);
    const result = f.run([cli, "--repo", f.repo, "--base", f.base, "--branch", "--connection", "a", "--json"], {NEEDLEFISH_EVAL_TRACE:"1",NEEDLEFISH_NO_RETRY:"0"});
    assert.equal(result.status,0,result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.verdict,"pass");
    assert.equal(output.traceDeliveryFailed,true);
    assert.equal(Object.hasOwn(output,"rawOutputs"),false);
    assert.equal(Object.hasOwn(output,"failedRawOutputs"),false);
    const cache = readFileSync(path.join(f.home, ".cache", "needlefish", "repo", "last-review.json"),"utf8");
    assert.deepEqual(JSON.parse(cache),output);
    assert.doesNotMatch(result.stdout + cache,/agent_thought_chunk|TEST-|ACCOUNT|rawOutputs|failedRawOutputs/);
    assert.equal(f.records().length,mode === "split-thought-failure" ? 3 : 2);
    f.clean();
  });
}

for (const mode of ["split-thought-success", "split-thought-failure"]) {
  for (const observer of [false,true]) {
    test(`${mode}: private observer=${observer} keeps auth trace delivery honest`, (t) => {
      const f = fixture(t,mode);
      const script = path.join(f.root,"trace.mjs");
      writeFileSync(script, `
import {review} from ${JSON.stringify(new URL("../core/review.ts",import.meta.url).href)};
import {diffBundle} from ${JSON.stringify(new URL("../adapters/local.ts",import.meta.url).href)};
import {resolveConnectionOptions} from ${JSON.stringify(new URL("./connections.ts",import.meta.url).href)};
import {score} from ${JSON.stringify(new URL("../../eval/shared/score.ts",import.meta.url).href)};
const repo=${JSON.stringify(f.repo)};
const {bundle}=diffBundle(repo,{base:${JSON.stringify(f.base)},localMode:'branch'});
const opts=resolveConnectionOptions({connection:'a'},repo), events=[];
const result=await review(bundle,opts,${observer ? "event=>events.push(event)" : "undefined"});
const rawEvents=events.filter(e=>e.surface==='raw_success'||e.surface==='raw_failure');
const fragments=rawEvents.map(e=>e.content.split('\\n').flatMap(line=>{try {const m=JSON.parse(line);return m.params?.update?.sessionUpdate==='agent_thought_chunk' ? [m.params.update.content.text] : [];}catch{return [];}}).join(''));
const scored=score(result,{verdict:'pass',mustFind:[]},'private-auth-trace',undefined,'syntheticcanary',undefined,events);
console.log(JSON.stringify({verdict:result.verdict,rawOutputs:Object.hasOwn(result,'rawOutputs'),failedRawOutputs:Object.hasOwn(result,'failedRawOutputs'),traceDeliveryFailed:result.traceDeliveryFailed,privateChunksVisible:fragments.includes(${JSON.stringify(keyA)}),robustnessAvailable:scored.robustness!==undefined}));
`);
      const result=f.run([script],{NEEDLEFISH_EVAL_TRACE:"1",NEEDLEFISH_NO_RETRY:"0"});
      assert.equal(result.status,0,result.stderr);
      assert.deepEqual(JSON.parse(result.stdout),{verdict:"pass",rawOutputs:false,failedRawOutputs:false,traceDeliveryFailed:!observer,privateChunksVisible:observer,robustnessAvailable:observer});
      f.clean();
    });
  }
}
