import assert from "node:assert/strict";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { commitAll, gitText, initRepo } from "./codex-runner-test-fixtures.js";
import type { RunStat } from "./runner.js";

const USAGE = { totalTokens: 30, inputTokens: 20, outputTokens: 10 };
const PRIVATE_TEXT = "named-launch-private-canary";
interface FixtureOptions {
  readonly fail?: boolean;
  readonly rewrite?: boolean;
  readonly noModel?: boolean;
  readonly docs?: boolean;
  readonly promptResult?: unknown;
  readonly scenario?: "silent" | "incompatible" | "permission" | "session-retry" | "auth";
}
interface Launch { readonly argv: string[]; readonly cwd: string; readonly home: string }
interface ClientMessage { readonly id?: unknown; readonly method?: string; readonly result?: unknown }

function records<T>(file: string): T[] {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as T) : [];
}

function fixture(t: TestContext, adapter: "acp" | "claude" = "acp", options: FixtureOptions = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "needlefish-connection-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = initRepo(dir);
  gitText(["branch", "-M", "main"], repo);
  const base = gitText(["rev-parse", "HEAD"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, options.docs ? "README.md" : "app.ts"), options.docs ? "more docs\n" : "export const added = 1;\n");
  commitAll(repo, "fixture change");
  const head = gitText(["rev-parse", "HEAD"], repo);
  const file = path.join(dir, "connections.json");
  const log = path.join(dir, "calls.jsonl");
  const launches = path.join(dir, "launches.jsonl");
  const messages = path.join(dir, "client.jsonl");
  const binary = path.join(dir, "agent with spaces");
  const response = JSON.stringify({ summary: "fixture review completed", findings: [], checked: ["app.ts"], residual_risks: [] });
  const capture = `
fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),home:process.env.HOME}) + '\\n');
function capture(prompt) {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({argv: process.argv.slice(2), cwd: process.cwd(), prompt,
    githubToken: !!process.env.GITHUB_TOKEN, ghToken: !!process.env.GH_TOKEN,
    configVisible: !!process.env.NEEDLEFISH_CONNECTIONS_FILE}) + '\\n');
  if (${!!options.rewrite}) fs.writeFileSync(${JSON.stringify(file)}, '{"version":1,"connections":[]}');
  if (${!!options.fail}) { process.stderr.write('quota exceeded'); process.exit(1); }
}
`;
  writeFileSync(binary, adapter === "acp" ? `#!/usr/bin/env node
const fs = require('node:fs');
${capture}
const scenario = ${JSON.stringify(options.scenario ?? "normal")};
const promptResult = ${JSON.stringify(options.promptResult === undefined ? { stopReason: "end_turn" } : options.promptResult)};
const attempt = fs.readFileSync(${JSON.stringify(launches)}, 'utf8').trim().split('\\n').length;
if (scenario === 'permission') process.on('SIGTERM', () => {});
const lines = require('node:readline').createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
lines.on('line', line => {
  fs.appendFileSync(${JSON.stringify(messages)}, line + '\\n');
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    if (scenario === 'silent') return;
    send({jsonrpc:'2.0',id:m.id,result:{protocolVersion:scenario === 'incompatible' ? 999 : 1,agentCapabilities:{}}});
  } else if (m.method === 'session/new') {
    if (scenario === 'session-retry' && attempt === 1) {
      if (${!!options.rewrite}) fs.writeFileSync(${JSON.stringify(file)}, '{"version":1,"connections":[]}');
      send({jsonrpc:'2.0',id:m.id,error:{code:-32603,message:${JSON.stringify(PRIVATE_TEXT)}}});
    } else send({jsonrpc:'2.0',id:m.id,result:{sessionId:'fixture-session'}});
  } else if (m.method === 'session/cancel') {
    setTimeout(() => process.exit(0), 25);
  } else if (m.method === 'session/prompt') {
    capture(m.params.prompt[0].text);
    const update = {jsonrpc:'2.0',method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:${JSON.stringify(response)}}}}};
    if (scenario === 'permission') {
      const permission = {jsonrpc:'2.0',id:'permission',method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'tool',title:${JSON.stringify(PRIVATE_TEXT)}},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}};
      process.stdout.write([permission, update, {jsonrpc:'2.0',id:m.id,result:promptResult}].map(JSON.stringify).join('\\n') + '\\n');
    } else {
      send(update);
      if (scenario === 'auth') send({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:${JSON.stringify(PRIVATE_TEXT)}}});
      else send({jsonrpc:'2.0',id:m.id,result:promptResult});
    }
  }
});
` : `#!/usr/bin/env node
const fs = require('node:fs');
${capture}
capture(fs.readFileSync(0,'utf8'));
process.stdout.write(${JSON.stringify(response)});
`);
  chmodSync(binary, 0o755);
  const args = options.noModel ? [] : ["acp", "--model", "{model}", "literal $(touch should-not-exist)"];
  writeFileSync(file, JSON.stringify({ version: 1, connections: [
    { id: "not-selected", adapter: "acp", launch: { command: path.join(dir, "must-not-run"), args: [] } },
    { id: "selected-connection-marker", adapter, ...(options.noModel ? {} : { model: "chosen-model" }),
      ...(adapter === "acp" ? { launch: { command: binary, args } } : {}) },
  ] }));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  mkdirSync(home); mkdirSync(bin); mkdirSync(path.join(dir, "temp"));
  const pr = { number: 7, baseRefOid: base, headRefOid: head, baseRefName: "main", headRefName: "feature", title: "fixture", body: "", comments: [], reviews: [], statusCheckRollup: [] };
  writeFileSync(path.join(bin, "gh"), `#!/usr/bin/env node
if (process.argv[2] !== 'pr') process.exit(2);
process.stdout.write(${JSON.stringify(JSON.stringify(pr))});
`);
  chmodSync(path.join(bin, "gh"), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) if (/^(NEEDLEFISH_|CODEX_|CLAUDE_|OPENAI_|PR_)/.test(key)) delete env[key];
  Object.assign(env, { HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    NEEDLEFISH_CONNECTIONS_FILE: file, NEEDLEFISH_MODEL: "wrong-ambient-model", NEEDLEFISH_RUNNER: "openai",
    NEEDLEFISH_NO_RETRY: "1", NEEDLEFISH_RETRY_MS: "1", NEEDLEFISH_TMPDIR: path.join(dir, "temp"),
    NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS: "1500",
    NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS: "50", NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "500",
    NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS: "100",
    ...(adapter === "acp" ? { NEEDLEFISH_EPHEMERAL_HOME: "1",
      NEEDLEFISH_ACP_AUTH_ENV_VARS: "TEST_ACP_TOKEN", NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "TEST_ACP_TOKEN",
      TEST_ACP_TOKEN: "fake-agent-credential" } : {}),
    NEEDLEFISH_ACP_BIN: path.join(dir, "wrong-ambient-command"), CLAUDE_BIN: binary,
    GITHUB_TOKEN: "fake-not-a-real-token", GH_TOKEN: "fake-not-a-real-token" });
  const run = (argv: readonly string[], selected = true) => spawnSync(process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), ...argv, "--repo", repo,
      ...(selected ? ["--connection", "selected-connection-marker"] : [])],
    { cwd: process.cwd(), env, encoding: "utf8", timeout: 20000 });
  const calls = (): { argv: string[]; cwd: string; prompt: string; githubToken: boolean; ghToken: boolean; configVisible: boolean }[] =>
    records(log);
  return { dir, repo, file, head, env, run, calls,
    launches: () => records<Launch>(launches), messages: () => records<ClientMessage>(messages) };
}

for (const adapter of ["claude", "acp"] as const) {
  for (const mode of ["local", "pr"] as const) {
    test(`${mode}: named ${adapter} connection reaches review and critic with the selected model`, (t) => {
      const f = fixture(t, adapter);
      const result = f.run([...(mode === "pr" ? ["pr", "7"] : []), "--json"]);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.verdict, "pass");
      assert.equal(output.schemaVersion, 1);
      assert.ok(output.stats.every((stat: {runner: string; model: string}) => stat.runner === adapter && stat.model === "chosen-model"));
      const calls = f.calls();
      assert.equal(calls.length, 2);
      for (const call of calls) {
        assert.ok(call.argv.includes("chosen-model"));
        assert.ok(!call.argv.includes("wrong-ambient-model"));
        assert.notEqual(call.cwd, f.repo);
        assert.equal(existsSync(call.cwd), false);
        assert.equal(call.githubToken, false);
        assert.equal(call.ghToken, false);
        assert.equal(call.configVisible, false);
        assert.doesNotMatch(call.prompt, /selected-connection-marker|acpLaunch|connections.json/);
      }
      assert.equal(gitText(["status", "--porcelain"], f.repo), "");
      assert.equal(existsSync(path.join(f.repo, "should-not-exist")), false);
      if (adapter === "acp") assert.ok(calls[0].argv.includes("literal $(touch should-not-exist)"));
    });
  }
}

test("selected ACP launch stays fixed if the user config changes between passes", (t) => {
  const f = fixture(t, "acp", { rewrite: true });
  const result = f.run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).connections, []);
});

test("ACP without a model neither forwards nor reports an ambient model", (t) => {
  const f = fixture(t, "acp", { noModel: true });
  const result = f.run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).stats.every((stat: { model?: string }) => stat.model === undefined));
  assert.ok(f.calls().every((call) => call.argv.length === 0));
});

test("quota failure does not activate another connection or write a success cache", (t) => {
  const f = fixture(t, "acp", { fail: true });
  const result = f.run(["--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(f.calls().length, 1);
  assert.equal(existsSync(path.join(f.dir, "home", ".cache", "needlefish")), false);
});

for (const output of [[], ["--json"], ["--print-bundle"]]) {
  test(`connection dry-run ${output[0] ?? "text"} validates without spawning or leaking config`, (t) => {
    const f = fixture(t);
    const result = f.run(["--dry-run", ...output]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.calls().length, 0);
    assert.doesNotMatch(result.stdout, /selected-connection-marker|acpLaunch|chosen-model|connections.json/);
    assert.equal(existsSync(path.join(f.dir, "home", ".cache", "needlefish")), false);
  });
}

test("legacy CLI ignores even malformed connection configuration", (t) => {
  const f = fixture(t, "claude");
  writeFileSync(f.file, "not JSON");
  const result = f.run(["--runner", "claude", "--model", "legacy-model", "--json"], false);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(f.calls().every((call) => call.argv.includes("legacy-model")));
});

test("docs-only named connection keeps the zero-model policy skip", (t) => {
  const f = fixture(t, "acp", { docs: true });
  const result = f.run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /model review skipped/);
  assert.equal(f.calls().length, 0);
});


// These are full CLI tests of the existing launch fixture, not a second ACP client.
for (const stopReason of ["cancelled", "refusal", "max_tokens", "max_turn_requests", undefined, "unknown"]) {
  test(`named ACP rejects ${stopReason ?? "missing stopReason"} despite valid JSON and usage`, (t) => {
    const f = fixture(t, "acp", { promptResult: { ...(stopReason === undefined ? {} : { stopReason }), usage: USAGE } });
    f.env.NEEDLEFISH_NO_RETRY = "0";
    const result = f.run(["--json"]);
    assertFailed(f, result);
    assert.match(result.stderr, /review not completed/);
  });
}

for (const validUsage of [true, false]) {
  test(`named ACP end_turn preserves the existing usage contract: valid=${validUsage}`, (t) => {
    const f = fixture(t, "acp", { promptResult: { stopReason: "end_turn", usage: validUsage ? USAGE : { totalTokens: -1 } } });
    const result = f.run(["--json"]);
    assert.equal(result.status, 0, result.stderr);
    const { stats } = JSON.parse(result.stdout) as { stats: RunStat[] };
    assert.equal(stats.length, 2);
    for (const stat of stats) {
      assert.equal(stat.runner, "acp");
      assert.equal(stat.model, "chosen-model");
      assert.equal(stat.ok, true);
      assert.deepEqual(stat.usage, validUsage ? USAGE : undefined);
    }
    assertDisposed(f);
  });
}

for (const scenario of ["silent", "incompatible"] as const) {
  test(`named ACP ${scenario} handshake fails before prompt delivery and without retry`, (t) => {
    const f = fixture(t, "acp", { scenario });
    f.env.NEEDLEFISH_NO_RETRY = "0";
    const result = f.run(["--json"]);
    assertFailed(f, result, 0);
    assert.match(result.stderr, /ACP initialize failed/);
    assert.deepEqual(f.messages().map((message) => message.method), ["initialize"]);
  });
}

test("named ACP permission cancellation cannot be revived by late end_turn and usage", (t) => {
  const f = fixture(t, "acp", { scenario: "permission", promptResult: { stopReason: "end_turn", usage: USAGE } });
  f.env.NEEDLEFISH_NO_RETRY = "0";
  const result = f.run(["--json"]);
  assertFailed(f, result);
  assert.match(result.stderr, /requested interactive permission/);
  assert.deepEqual(f.messages().find((message) => message.id === "permission")?.result,
    { outcome: { outcome: "cancelled" } });
  assert.equal(f.messages().filter((message) => message.method === "session/cancel").length, 1);
});

test("named ACP session/new retry keeps frozen launch and successful usage after config changes", (t) => {
  const f = fixture(t, "acp", { scenario: "session-retry", rewrite: true,
    promptResult: { stopReason: "end_turn", usage: USAGE } });
  f.env.NEEDLEFISH_NO_RETRY = "0";
  const result = f.run(["--json"]);
  assert.equal(result.status, 0, result.stderr);
  const { stats } = JSON.parse(result.stdout) as { stats: RunStat[] };
  assert.deepEqual(stats.map((stat) => stat.attempts), [2, 1]);
  assert.ok(stats.every((stat) => stat.ok && stat.model === "chosen-model"));
  assert.ok(stats.every((stat) => JSON.stringify(stat.usage) === JSON.stringify(USAGE)));
  assert.equal(f.launches().length, 3);
  assert.equal(f.calls().length, 2);
  assert.deepEqual(JSON.parse(readFileSync(f.file, "utf8")).connections, []);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(PRIVATE_TEXT));
  assertDisposed(f);
});

test("named ACP structured authentication failure is redacted and not retried", (t) => {
  const f = fixture(t, "acp", { scenario: "auth" });
  f.env.NEEDLEFISH_NO_RETRY = "0";
  const result = f.run(["--json"]);
  assertFailed(f, result);
  assert.match(result.stderr, /authentication required/);
});

function assertFailed(f: ReturnType<typeof fixture>, result: SpawnSyncReturns<string>, prompts = 1): void {
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(f.calls().length, prompts);
  assert.equal(f.launches().length, 1, "non-retryable failure must not launch a second attempt or critic");
  assert.doesNotMatch(result.stderr, new RegExp(`${PRIVATE_TEXT}|no JSON object found`));
  assert.equal(existsSync(path.join(f.dir, "home", ".cache", "needlefish")), false);
  assertDisposed(f);
}

function assertDisposed(f: ReturnType<typeof fixture>): void {
  for (const launch of f.launches()) {
    assert.ok(launch.argv.includes("chosen-model"));
    assert.notEqual(launch.cwd, f.repo);
    assert.equal(existsSync(launch.cwd), false, "throwaway clone is disposed");
    assert.notEqual(launch.home, path.join(f.dir, "home"));
    assert.equal(existsSync(launch.home), false, "ephemeral HOME is disposed");
  }
  assert.equal(gitText(["rev-parse", "HEAD"], f.repo), f.head);
  assert.equal(gitText(["status", "--porcelain"], f.repo), "");
}
