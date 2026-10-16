import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { AcpEnvironmentAuth, parseAuthEnvironment } from "./connection-auth.js";
import type { RunnerOptions } from "./runner.js";
import { parseConnections, resolveConnectionOptions } from "./connections.js";

const refs = { AGENT_API_KEY: "ACCOUNT_A_KEY", AGENT_SESSION_TOKEN: "ACCOUNT_A_TOKEN" };
const env = { ACCOUNT_A_KEY: "TEST-A-KEY", ACCOUNT_A_TOKEN: "TEST-A-TOKEN" };
const entry = (id: string, auth: unknown = { env: refs }) => ({
  id, adapter: "acp", launch: { command: process.execPath, args: [] }, auth,
});
function fixture(t: TestContext, connections: unknown[] = [entry("a")]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-auth-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  const file = path.join(root, "connections.json");
  writeFileSync(file, JSON.stringify({ version: 1, connections }));
  return { repo, file, env: { ...env, NEEDLEFISH_CONNECTIONS_FILE: file } };
}

test("auth references are copied/frozen without reading or modifying credentials", () => {
  const input = { ...refs };
  const parsed = parseAuthEnvironment(input);
  assert.deepEqual(parsed, input);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(!Object.isFrozen(input));
  input.AGENT_API_KEY = "CHANGED";
  assert.equal(parsed.AGENT_API_KEY, "ACCOUNT_A_KEY");
});

for (const raw of [null, [], "key", {}, { AGENT_API_KEY: 1 }, { AGENT_API_KEY: "secret with spaces" }, { AGENT_API_KEY: "$TOKEN" }]) {
  test(`auth map rejects ${JSON.stringify(raw)}`, () => assert.throws(() => parseAuthEnvironment(raw)));
}
for (const target of ["PATH", "HOME", "XDG_CONFIG_HOME", "NODE_OPTIONS", "HTTPS_PROXY", "GH_TOKEN", "GITHUB_TOKEN", "GIT_ACCESS_TOKEN", "NEEDLEFISH_TOKEN", "__proto__"]) {
  test(`auth cannot override ${target}`, () => assert.throws(() => parseAuthEnvironment({ [target]: "ACCOUNT_A_KEY" })));
}
for (const source of [
  "GH_TOKEN", "GITHUB_TOKEN", "gh_token", "GitHub_Token", "GIT_PASSWORD",
  "NEEDLEFISH_TOKEN", "needlefish_model", "HOME", "home", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "XDG_CONFIG_HOME", "PATH", "PATHEXT", "SHELL", "COMSPEC", "BASH_ENV", "ENV",
  "NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HTTP_PROXY", "https_proxy", "ALL_PROXY", "NO_PROXY",
]) {
  test(`auth cannot forward reserved source ${source}`, () => assert.throws(() => parseAuthEnvironment({ AGENT_API_KEY: source })));
}
for (const value of [undefined, "", " \n ", "TEST-SECRET\0TAIL", " TEST-SECRET", "TEST-SECRET ", "TEST-SECRET\n"]) {
  test(`missing/invalid credential fails without exposing its value (${typeof value}:${value?.length ?? 0})`, () => {
    assert.throws(() => new AcpEnvironmentAuth({ AGENT_API_KEY: "ACCOUNT_A_KEY" }, { ACCOUNT_A_KEY: value }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /no default account/);
      assert.doesNotMatch(error.message, /TEST-SECRET|TAIL/);
      return true;
    });
  });
}

test("bound credentials survive source mutation and stay out of JSON/inspection", () => {
  const source = { ...env };
  const auth = new AcpEnvironmentAuth(refs, source);
  source.ACCOUNT_A_KEY = "CHANGED";
  const child: NodeJS.ProcessEnv = {};
  auth.applyTo(child);
  assert.deepEqual(child, { AGENT_API_KEY: env.ACCOUNT_A_KEY, AGENT_SESSION_TOKEN: env.ACCOUNT_A_TOKEN });
  child.AGENT_API_KEY = "CHILD-WRITE";
  const another: NodeJS.ProcessEnv = {};
  auth.applyTo(another);
  assert.equal(another.AGENT_API_KEY, env.ACCOUNT_A_KEY);
  assert.ok(Object.isFrozen(auth));
  assert.doesNotMatch(JSON.stringify({ auth }) + inspect(auth, { showHidden: true }), /TEST-A|ACCOUNT_A/);
});

test("native adapters and nonempty legacy passthrough fail explicitly", () => {
  const auth = new AcpEnvironmentAuth(refs, env);
  assert.throws(() => auth.assertCompatible("claude", {}), /acp adapter/);
  assert.throws(() => auth.assertCompatible("acp", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "OPENAI_BASE_URL" }), /routing settings/);
  auth.assertCompatible("acp", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: " " });
});

test("diagnostics use the frozen credentials and preserve safe messages", () => {
  const source = { ...env };
  const auth = new AcpEnvironmentAuth(refs, source);
  source.ACCOUNT_A_KEY = "CHANGED";
  assert.match(auth.screenDiagnostic(`auth error (${env.ACCOUNT_A_KEY.toLowerCase()})`), /withheld.*credential/);
  assert.equal(auth.screenDiagnostic("ACP initialize timeout"), "ACP initialize timeout");
});

test("configuration permits only explicit ACP env authentication", () => {
  for (const auth of [null, {}, { env: refs, files: [] }, { files: ["auth.json"] }]) {
    assert.throws(() => parseConnections({ version: 1, connections: [entry("a", auth)] }));
  }
  assert.throws(() => parseConnections({ version: 1, connections: [{ ...entry("a"), adapter: "claude", model: "m" }] }), /only by the acp/);
  const parsed = parseConnections({ version: 1, connections: [entry("a")] });
  assert.deepEqual(parsed[0].auth?.env, refs);
  assert.ok(Object.isFrozen(parsed[0].auth));
});

test("selection binds only the chosen account; an unused missing account is not read", (t) => {
  const f = fixture(t, [entry("a"), entry("b", { env: { AGENT_API_KEY: "ACCOUNT_B_KEY" } })]);
  const before = { ...f.env };
  const a = resolveConnectionOptions<RunnerOptions>({ connection: "a" }, f.repo, f.env);
  const child: NodeJS.ProcessEnv = {};
  a.connectionAuth!.applyTo(child);
  assert.equal(child.AGENT_API_KEY, env.ACCOUNT_A_KEY);
  assert.deepEqual(f.env, before);
  assert.doesNotMatch(JSON.stringify(a), /TEST-A/);
  assert.throws(() => resolveConnectionOptions<RunnerOptions>({ connection: "b" }, f.repo, f.env), /missing/);
});

test("two bound selections do not alias even when used concurrently", async (t) => {
  const f = fixture(t, [entry("a"), entry("b", { env: { AGENT_API_KEY: "ACCOUNT_B_KEY" } })]);
  const source = { ...f.env, ACCOUNT_B_KEY: "TEST-B-KEY" };
  const a = resolveConnectionOptions<RunnerOptions>({ connection: "a" }, f.repo, source);
  const b = resolveConnectionOptions<RunnerOptions>({ connection: "b" }, f.repo, source);
  source.ACCOUNT_A_KEY = source.ACCOUNT_B_KEY = "CHANGED";
  writeFileSync(f.file, "now invalid");
  const children = await Promise.all([a, b].map(async (opts) => {
    const child: NodeJS.ProcessEnv = {};
    await Promise.resolve();
    opts.connectionAuth!.applyTo(child);
    return child;
  }));
  assert.equal(children[0].AGENT_API_KEY, "TEST-A-KEY");
  assert.deepEqual(children[1], { AGENT_API_KEY: "TEST-B-KEY" });
});

test("separate auth cannot be combined with an unresolved selector", (t) => {
  const f = fixture(t);
  assert.throws(() => resolveConnectionOptions<RunnerOptions>({ connection: "a", connectionAuth: new AcpEnvironmentAuth(refs, env) }, f.repo, f.env), /cannot be combined/);
});

test("Unicode screening covers mixed escapes and surrogate pairs without changing credentials", () => {
  const auth = new AcpEnvironmentAuth({ AGENT_API_KEY:"SOURCE" }, {SOURCE:"KEY🙂tail"});
  for (const text of ["note KEY\\ud83d\\ude42tail", "note K\\u0045Y🙂tail", "note KEY🙂tail"]) {
    assert.throws(() => auth.assertOutputSafe(text), {name:"ConnectionCredentialLeakError"});
    assert.equal(auth.screenDiagnostic(text), "Needlefish withheld runner diagnostic: it contained a selected connection credential.");
  }
  const child: NodeJS.ProcessEnv = {};
  auth.applyTo(child);
  assert.deepEqual(child,{AGENT_API_KEY:"KEY🙂tail"});
  assert.equal(auth.screenDiagnostic("ordinary safe diagnostic"),"ordinary safe diagnostic");
});

test("one-pass JSON screening handles every JSON escape without recursive decoding", () => {
  for (const token of ['"', "\\", "/", "\b", "\f", "\n", "\r", "\t"]) {
    const value = `KEY${token}tail`;
    const auth = new AcpEnvironmentAuth({ AGENT_API_KEY: "SOURCE" }, { SOURCE: value });
    const escaped = JSON.stringify(value).slice(1, -1).replace("/", "\\/");
    assert.throws(() => auth.assertOutputSafe(`prefix ${escaped}`), { name: "ConnectionCredentialLeakError" });
    assert.equal(auth.screenDiagnostic(`prefix ${escaped}`), "Needlefish withheld runner diagnostic: it contained a selected connection credential.");
    const child: NodeJS.ProcessEnv = {};
    auth.applyTo(child);
    assert.deepEqual(child, { AGENT_API_KEY: value });
  }
  const auth = new AcpEnvironmentAuth({ AGENT_API_KEY: "SOURCE" }, { SOURCE: "KEYtail" });
  assert.equal(auth.screenDiagnostic("prefix KEY\\u005ctail"), "prefix KEY\\u005ctail");
  assert.equal(auth.screenDiagnostic("prefix K\\u005cu0045Ytail"), "prefix K\\u005cu0045Ytail");
});
