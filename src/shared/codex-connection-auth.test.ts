import { spawnSync } from "node:child_process";
import { review } from "../core/review.js";
import type { Bundle } from "./schema.js";
import { runDoctor, serializeDoctorReport } from "../adapters/doctor.js";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { inspect } from "node:util";
import { runCodex, resolveRunnerConfig } from "./codex.js";
import { parseConnections, resolveConnectionOptions } from "./connections.js";
import { commitAll, headSha, initRepo } from "./codex-runner-test-fixtures.js";
import { captureEnv, restoreEnv } from "./runner-test-fixtures.js";
import { ConnectionCredentialLeakError } from "./runner-failure.js";
import type { RunnerOptions } from "./runner.js";

const keyA = "FAKE-SELECTED-A-🙂-tail", keyB = "FAKE-SELECTED-B-tail";
const direct = { kind: "openai" };
const proxy = { kind: "cliproxyapi", baseUrl: "http://127.0.0.1:8317/v1" };
const entry = (id = "a", route: unknown = direct, target = "CODEX_API_KEY", source = "ACCOUNT_A_KEY") => ({
  id, adapter: "codex", model: "selected-model", auth: { env: { [target]: source }, route },
});
const config = (connections: unknown[]) => ({ version: 1, connections });
const userinfoUrl = new URL("https://proxy.invalid/v1");
userinfoUrl.username = "user";
userinfoUrl.password = "secret";

function fixture(t: TestContext, mode = "success", entries = [entry()]) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-codex-account-"));
  const keys = ["HOME", "USERPROFILE", "CODEX_HOME", "CODEX_BIN", "CODEX_API_KEY", "CODEX_PROXY_API_KEY", "CODEX_PROXY_BASE_URL", "NEEDLEFISH_CODEX_PROXY_REQUIRED", "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", "NEEDLEFISH_NO_RETRY", "NEEDLEFISH_RETRY_MS", "NEEDLEFISH_CONNECTIONS_FILE", "ACCOUNT_A_KEY", "ACCOUNT_B_KEY", "GH_TOKEN", "GITHUB_TOKEN", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NEEDLEFISH_EPHEMERAL_HOME", "NEEDLEFISH_ACP_AUTH_FILES"];
  const previous = captureEnv(keys);
  t.after(() => { restoreEnv(previous); rmSync(root, { recursive: true, force: true }); });
  for (const key of keys) delete process.env[key];
  const repo = initRepo(root);
  writeFileSync(path.join(repo, "source.ts"), "export const value = 1;\n");
  commitAll(repo, "source");
  const home = path.join(root, "ambient-home");
  mkdirSync(path.join(home, ".codex", "skills"), { recursive: true });
  for (const file of ["auth.json", "config.toml", "history.jsonl"]) writeFileSync(path.join(home, ".codex", file), "ambient private bytes");
  const file = path.join(root, "connections.json"), log = path.join(root, "calls.jsonl"), binary = path.join(root, "codex");
  writeFileSync(file, JSON.stringify(config(entries)));
  writeFileSync(binary, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),log=${JSON.stringify(log)},mode=${JSON.stringify(mode)};
const calls=fs.existsSync(log)?fs.readFileSync(log,'utf8').trim().split('\\n').length:0;
fs.appendFileSync(log,JSON.stringify({args,cwd:process.cwd(),env:process.env,files:fs.readdirSync(process.env.CODEX_HOME||process.env.HOME)})+'\\n');
const key=process.env.CODEX_API_KEY||process.env.CODEX_PROXY_API_KEY;
if(args[0]!=='exec'){process.stdout.write('DO NOT PUBLISH '+key);process.exit(0)}
if(mode==='retry'&&calls===0){process.stderr.write('temporary failure');process.exit(1)}
if(mode==='failed-raw'){process.stdout.write(key);process.exit(1)}
if(mode==='stderr')process.stderr.write(key);
if(mode==='escaped-stderr')process.stderr.write(JSON.stringify(key));
const prompt=fs.readFileSync(0,'utf8');
const result=prompt.includes('review-MAP pass')?{summary:'mapped',hotspots:[{name:'source',files:['source.ts'],why:'changed',risk:'high',edges:[]}]}:{summary:'Checked source',checked:['source.ts'],findings:[],residual_risks:[]};
const output=mode==='decoded'?JSON.stringify({summary:key}):mode==='review'?JSON.stringify(result):'{}';
if(mode==='escaped-stderr')process.stderr.write(key.split('').map(c=>String.fromCharCode(92)+'u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join(''));
fs.writeFileSync(args[args.indexOf('--output-last-message')+1],output);
process.stdin.resume();
`);
  chmodSync(binary, 0o755);
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, ".codex"), CODEX_BIN: binary, ACCOUNT_A_KEY: keyA, ACCOUNT_B_KEY: keyB, GH_TOKEN: "FAKE-AMBIENT-GH", GITHUB_TOKEN: "FAKE-AMBIENT-GITHUB", NEEDLEFISH_NO_RETRY: "0", NEEDLEFISH_RETRY_MS: "1", NEEDLEFISH_CONNECTIONS_FILE: file, NEEDLEFISH_ACP_AUTH_FILES: ".codex/auth.json" });
  const select = (id = "a") => resolveConnectionOptions<RunnerOptions>({ connections: [id] }, repo);
  const calls = (): {args: string[]; cwd: string; env: NodeJS.ProcessEnv; files: string[]}[] => existsSync(log) ? JSON.parse(`[${readFileSync(log, "utf8").trim().split("\n").join(",")}]`) : [];
  const run = (opts = select(), callbacks = {}) => runCodex("Inspect source", { ...opts, repoPath: repo, targetHeadSha: headSha(repo), ...callbacks });
  return { root, repo, home, file, select, calls, run };
}

for (const route of [direct, proxy]) {
  test(`Codex ${route.kind} binds exactly one selected key, freezes passes and cleans owned homes`, async (t) => {
    const target = route.kind === "openai" ? "CODEX_API_KEY" : "CODEX_PROXY_API_KEY";
    const f = fixture(t, "retry", [entry("a", route, target), entry("b", route, target, "ACCOUNT_B_KEY")]);
    if (route.kind === "cliproxyapi") Object.assign(process.env, { CODEX_PROXY_BASE_URL: "https://ambient.invalid/v1", CODEX_PROXY_API_KEY: "FAKE-AMBIENT-PROXY" });
    const before = { ...process.env }, selected = f.select();
    process.env.ACCOUNT_A_KEY = keyB;
    assert.equal(await f.run(selected), "{}");
    assert.equal(await f.run(selected), "{}");
    assert.equal(await f.run(f.select("b")), "{}");
    const calls = f.calls();
    assert.equal(calls.length, 4);
    assert.deepEqual(calls.map(c => c.env[target]), [keyA, keyA, keyA, keyB]);
    for (const call of calls) {
      assert.equal(call.env[target === "CODEX_API_KEY" ? "CODEX_PROXY_API_KEY" : "CODEX_API_KEY"], undefined);
      for (const name of ["ACCOUNT_A_KEY", "ACCOUNT_B_KEY", "GH_TOKEN", "GITHUB_TOKEN", "CODEX_PROXY_BASE_URL"]) assert.equal(call.env[name], undefined);
      assert.equal(call.env.HOME, call.env.USERPROFILE);
      assert.equal(call.env.CODEX_HOME, path.join(call.env.HOME!, ".codex"));
      assert.deepEqual(call.files, []);
      assert.ok(call.args.includes('cli_auth_credentials_store="file"'));
      assert.ok(call.args.includes("--ignore-user-config") && call.args.includes("--ignore-rules"));
      assert.ok(call.args.includes("selected-model"));
      assert.equal(call.env.GIT_CONFIG_GLOBAL, "/dev/null");
      assert.equal(call.env.GIT_CONFIG_SYSTEM, "/dev/null");
      assert.equal(call.env.GIT_CONFIG_NOSYSTEM, "1");
      assert.notEqual(call.cwd, f.repo);
      assert.equal(existsSync(call.cwd), false);
      assert.equal(existsSync(call.env.HOME!), false);
      assert.doesNotMatch(JSON.stringify(call.args), /FAKE-|ambient\.invalid/);
      assert.equal(call.args.some(arg => arg.includes('model_provider="cliproxyapi"')), route.kind === "cliproxyapi");
    }
    assert.doesNotMatch(JSON.stringify(selected) + inspect(selected, { showHidden: true }), /FAKE-|ACCOUNT_A_KEY/);
    assert.equal(process.env.HOME, before.HOME);
    assert.equal(process.env.ACCOUNT_A_KEY, keyB);
    assert.equal(readFileSync(path.join(f.home, ".codex", "auth.json"), "utf8"), "ambient private bytes");
  });
}

for (const bad of [undefined, "", " ", " key", "key ", "key tail", "key\ttail", "key\ntail", "key\0tail"]) {
  test(`Codex missing or invalid selected key fails before spawn (${typeof bad}:${bad?.length})`, (t) => {
    const f = fixture(t);
    const env = { ...process.env, ACCOUNT_A_KEY: bad };
    assert.throws(() => resolveConnectionOptions<RunnerOptions>({ connections: ["a"] }, f.repo, env), /credential/);
    assert.deepEqual(f.calls(), []);
  });
}

for (const ambient of [{ CODEX_PROXY_BASE_URL: "http://localhost:1" }, { CODEX_PROXY_API_KEY: "FAKE-AMBIENT" }, { NEEDLEFISH_CODEX_PROXY_REQUIRED: "1" }, { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "OPENAI_API_KEY" }]) {
  test(`Codex direct rejects ambient routing conflict ${Object.keys(ambient)[0]}`, (t) => {
    const f = fixture(t);
    Object.assign(process.env, ambient);
    assert.throws(() => f.select(), /routing|proxy|passthrough/i);
    assert.deepEqual(f.calls(), []);
  });
}

for (const [route, target] of [[undefined, "CODEX_API_KEY"], [direct, "CODEX_PROXY_API_KEY"], [proxy, "CODEX_API_KEY"], [{ kind: "cliproxyapi", baseUrl: "https://proxy.invalid/v1/%zz" }, "CODEX_PROXY_API_KEY"], [{ kind: "cliproxyapi", baseUrl: "https://@proxy.invalid/v1" }, "CODEX_PROXY_API_KEY"], [{ kind: "cliproxyapi", baseUrl: "https://proxy.invalid/v1?" }, "CODEX_PROXY_API_KEY"], [{ kind: "cliproxyapi", baseUrl: "https://proxy.invalid/v1#" }, "CODEX_PROXY_API_KEY"], [{ kind: "cliproxyapi", baseUrl: userinfoUrl.href }, "CODEX_PROXY_API_KEY"], [{ kind: "cliproxyapi", baseUrl: "https://proxy.invalid/v1?key=secret" }, "CODEX_PROXY_API_KEY"], [{ kind: "cliproxyapi", baseUrl: "https://proxy.invalid/v1#secret" }, "CODEX_PROXY_API_KEY"]] as const) {
  test(`Codex route contract rejects ${JSON.stringify(route)} / ${target}`, () => assert.throws(() => parseConnections(config([{ ...entry("a", route, target), auth: { env: { [target]: "ACCOUNT_A_KEY" }, route } }]))));
}

for (const mode of ["failed-raw", "stderr", "escaped-stderr", "decoded"]) {
  test(`Codex ${mode} leak is typed, private raw stays observable and no retry occurs`, async (t) => {
    const f = fixture(t, mode);
    const raw: string[] = [];
    await assert.rejects(() => f.run(f.select(), { onRaw: (s: string) => raw.push(s), onFailedRaw: (s: string) => raw.push(s) }), ConnectionCredentialLeakError);
    assert.equal(f.calls().length, 1);
    assert.ok(raw.join("\n").includes(keyA) || raw.join("\n").includes(JSON.stringify(keyA)));
  });
}

test("selected key rotations retain old and new diagnostic guards", (t) => {
  const f = fixture(t);
  const old = f.select();
  process.env.ACCOUNT_A_KEY = keyB;
  const next = f.select();
  assert.throws(() => old.connectionAuth!.assertOutputSafe(keyA), ConnectionCredentialLeakError);
  assert.throws(() => next.connectionAuth!.assertOutputSafe(keyB), ConnectionCredentialLeakError);
  assert.equal(old.connectionAuth!.screenDiagnostic(keyA).includes(keyA), false);
  assert.equal(next.connectionAuth!.screenDiagnostic(keyB).includes(keyB), false);
  assert.equal(resolveRunnerConfig(old).codexProxy, undefined);
});


test("doctor selects the credential source without invoking CLI or presenting identity", (t) => {
  const f = fixture(t);
  const report = runDoctor({ repo: f.repo, version: "test", connection: "a" });
  assert.deepEqual(report.checks.find(check => check.name === "auth"), {
    name: "auth", status: "unknown", detail: "codex: credential source chosen; provider account identity unknown; login state not probed",
  });
  assert.doesNotMatch(serializeDoctorReport(report), /FAKE-|ACCOUNT_A|DO NOT PUBLISH|ambient-home|[a-f0-9]{64}/);
  assert.deepEqual(f.calls(), []);
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--repo", f.repo, "--connection", "a", "--base", "HEAD", "--json"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /credential source chosen; provider account identity unknown/);
  assert.deepEqual(f.calls(), []);
});

test("doctor missing selected source never probes an ambient account", (t) => {
  const f = fixture(t);
  delete process.env.ACCOUNT_A_KEY;
  assert.throws(() => runDoctor({ repo: f.repo, version: "test", connection: "a" }), /credential/);
  assert.deepEqual(f.calls(), []);
});


for (const deep of [false, true]) {
  test(`Codex actual ${deep ? "map/deep/critic" : "review/critic"} pipeline reuses selection after env rotation`, async (t) => {
    const f = fixture(t, "review");
    const selection = f.select();
    const bundle: Bundle = { repoPath: f.repo, baseSha: headSha(f.repo), headSha: headSha(f.repo), patch: "short", patchStat: "source.ts | 1 +", changedFiles: [{ path: "source.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep, focus: null };
    const trace: string[] = [];
    const result = await review(bundle, selection, event => { trace.push(JSON.stringify(event)); }, () => {
      process.env.ACCOUNT_A_KEY = keyB;
      process.env.CODEX_PROXY_API_KEY = "FAKE-LATE-PROXY";
      process.env.CODEX_PROXY_BASE_URL = "https://late.invalid/v1";
    });
    assert.equal(result.verdict, "pass");
    assert.equal(f.calls().length, deep ? 3 : 2);
    assert.ok(f.calls().every(call => call.env.CODEX_API_KEY === keyA && call.env.CODEX_PROXY_API_KEY === undefined));
    assert.ok(f.calls().every(call => !call.args.some(arg => arg.includes("cliproxyapi"))));
    assert.ok(trace.length > 0);
    assert.doesNotMatch(JSON.stringify(result), /FAKE-|ACCOUNT_A|late.invalid/);
  });
}

test("Codex credential output remains in private trace but absent from public review diagnostics", async (t) => {
  const f = fixture(t, "stderr");
  const bundle: Bundle = { repoPath: f.repo, baseSha: headSha(f.repo), headSha: headSha(f.repo), patch: "short", patchStat: "source.ts | 1 +", changedFiles: [{ path: "source.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null };
  const trace: string[] = [];
  await assert.rejects(() => review(bundle, f.select(), event => { trace.push(JSON.stringify(event)); }), error => {
    assert.ok(error instanceof ConnectionCredentialLeakError);
    assert.equal(error.retryable, false);
    assert.doesNotMatch(error.message, /FAKE-|ACCOUNT_A/);
    return true;
  });
  assert.ok(trace.join("\n").includes(keyA));
  assert.equal(f.calls().length, 1);
});


test("Codex refuses a percent-encoded selected credential in the route before spawn", (t) => {
  const encoded = Array.from(Buffer.from(keyA)).map(byte => `%${byte.toString(16).padStart(2, "0")}`).join("");
  const route = { kind: "cliproxyapi", baseUrl: `https://proxy.invalid/v1/${encoded}` };
  const f = fixture(t, "success", [entry("a", route, "CODEX_PROXY_API_KEY")]);
  assert.throws(() => f.select(), ConnectionCredentialLeakError);
  assert.deepEqual(f.calls(), []);
});


test("Codex preserves a safe encoded proxy route in the actual child argv", async (t) => {
  const route = { kind: "cliproxyapi", baseUrl: "https://proxy.invalid/api%2Fv1" };
  const f = fixture(t, "success", [entry("a", route, "CODEX_PROXY_API_KEY")]);
  assert.equal(await f.run(), "{}");
  assert.ok(f.calls()[0].args.includes('model_providers.cliproxyapi.base_url="https://proxy.invalid/api%2Fv1"'));
  assert.equal(f.calls()[0].env.CODEX_PROXY_API_KEY, keyA);
});
