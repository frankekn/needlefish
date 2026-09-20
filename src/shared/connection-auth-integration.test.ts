import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function fixture(t: TestContext, mode = "success") {
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
    if (mode === 'auth-error') {
      send({id:request.id,error:{code:-32000,message:'auth rejected TEST-ACCOUNT-A'}});
    } else {
      send({method:'session/update',params:{sessionId:'test-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(reviewJson)}}}}});
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
    ACCOUNT_A_KEY: keyA, ACCOUNT_B_KEY: keyB, AGENT_API_KEY: "WRONG-DEFAULT",
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
import {runCodex} from ${JSON.stringify(new URL("./codex.ts", import.meta.url).href)};
import {resolveConnectionOptions} from ${JSON.stringify(new URL("./connections.ts", import.meta.url).href)};
const repo = ${JSON.stringify(f.repo)}, head = ${JSON.stringify(f.head)};
const opts = ${parallel ? "['a','b']" : "['a']"}.map(connection => resolveConnectionOptions({connection,repoPath:repo,targetHeadSha:head},repo));
// Both real executions must retain selection-time values across concurrent calls and retries.
process.env.ACCOUNT_A_KEY = process.env.ACCOUNT_B_KEY = 'CHANGED-AFTER-SELECTION';
let sawFailedRaw = false;
try {
  const results = await Promise.all(opts.map(opt => runCodex('Return review JSON', {...opt,onFailedRaw:raw => {sawFailedRaw ||= raw.includes('TEST-ACCOUNT-A');}})));
  console.log(JSON.stringify({ok:true,count:results.length,globalUnchanged:process.env.ACCOUNT_A_KEY === 'CHANGED-AFTER-SELECTION'}));
} catch(error) {
  console.log(JSON.stringify({ok:false,message:error.message,sawFailedRaw}));
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

for (const [name, overrides, expected] of [
  ["missing account", { ACCOUNT_A_KEY: "" }, /no default account/],
  ["legacy routing passthrough", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "OPENAI_BASE_URL" }, /routing settings/],
] as const) {
  test(`CLI ${name} stops before any agent starts`, (t) => {
    const f = fixture(t);
    const result = f.run([cli, "--repo", f.repo, "--connection", "a"], overrides);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(f.records().length, 0);
    f.clean();
  });
}
