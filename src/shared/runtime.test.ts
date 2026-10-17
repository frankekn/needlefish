import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { review } from "../core/review";
import { promptHash } from "./prompt-hash";
import { buildRunnerEnv, resolveRunnerConfig } from "./codex";
import { capturedCodexEnvironment, codexAuthRoot, prepareCapturedCodexHome, publicNativeCodexDigest } from "./codex-invocation";
import { codexPublicEnvironment } from "./codex-public-environment";
import { AcpEnvironmentAuth } from "./connection-auth";
import { parseConnections } from "./connections";
import { ConnectionCredentialLeakError } from "./runner-failure";
import { commitAll, headSha, initRepo, isolateCodexTestHome } from "./codex-runner-test-fixtures";
import { renderMarkdown } from "./render";
import { parseReviewResult } from "./review-result";
import { parseReviewRuntime, reviewRuntime, sourceShaFromRelease } from "./runtime";
import { parsePositiveInteger } from "./runner";
import { serializeReviewResult, type Bundle } from "./schema";

function environment(t: TestContext, values: Readonly<Record<string, string | undefined>>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

test("runtime records effective defaults and never qualifies incomplete identities", (t) => {
  environment(t, { NEEDLEFISH_MODEL: undefined, PI_MODEL: undefined, GROK_MODEL: undefined });
  const pi = reviewRuntime(resolveRunnerConfig({ runner: "pi" }), null);
  assert.deepEqual(pi.model, { status: "known", value: "gpt-5.6-sol" });
  assert.deepEqual(pi.effort, { status: "known", value: "medium" });
  assert.deepEqual(pi.promptHash, { status: "known", value: promptHash() });
  assert.deepEqual(pi.qualification, { matchStatus: "unqualified" });
  assert.deepEqual(pi.runnerVersion, { status: "unknown" });
  assert.deepEqual(pi.launcherDigest, { status: "unknown" });
  assert.deepEqual(reviewRuntime(resolveRunnerConfig({ runner: "grok" }), null).model, { status: "known", value: "grok-build" });
  const acp = reviewRuntime(resolveRunnerConfig({ runner: "acp", model: "caller-guess", reasoningEffort: "high" }), 30000);
  assert.deepEqual(acp.model, { status: "unknown" });
  assert.deepEqual(acp.effort, { status: "unknown" });
  assert.deepEqual(acp.qualification, { matchStatus: "unqualified" });
  assert.equal(acp.reviewBudgetMs, 30000);
  assert.throws(() => resolveRunnerConfig({ runner: "opencode", model: "provider/model#low", reasoningEffort: "high" }), /OpenCode reviews are temporarily disabled/);
  assert.throws(() => parseReviewRuntime({ ...acp, qualification: { matchStatus: "tested" } }), /qualification/);
  assert.deepEqual(parseReviewRuntime({ ...acp, runnerVersion: { status: "operator_attested", value: "1.2.3" } }).runnerVersion, { status: "operator_attested", value: "1.2.3" });
});

test("effective config preserves bound auth methods and the frozen parsed ACP launch", (t) => {
  environment(t, { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: undefined });
  const [connection] = parseConnections({ version: 1, connections: [{
    id: "selected", adapter: "acp", model: "selected-model",
    launch: { command: process.execPath, args: ["--model", "{model}"] },
  }] });
  const source = { SELECTED_ACCOUNT_KEY: "TEST-BOUND-ACCOUNT" };
  const auth = new AcpEnvironmentAuth({ AGENT_API_KEY: "SELECTED_ACCOUNT_KEY" }, source);
  const config = resolveRunnerConfig({ runner: "acp", acpLaunch: connection!.launch, connectionAuth: auth });
  source.SELECTED_ACCOUNT_KEY = "TEST-REPLACEMENT-ACCOUNT";
  assert.equal(config.connectionAuth, auth);
  assert.equal(config.acpLaunch, connection!.launch);
  assert.equal(Object.isFrozen(config.acpLaunch), true);
  assert.equal(Object.isFrozen(config.acpLaunch!.args), true);
  assert.deepEqual(config.acpLaunch!.args, ["--model", "selected-model"]);
  const childEnv: NodeJS.ProcessEnv = {};
  config.connectionAuth!.applyTo(childEnv);
  assert.deepEqual(childEnv, { AGENT_API_KEY: "TEST-BOUND-ACCOUNT" });
  assert.throws(() => config.connectionAuth!.assertOutputSafe("TEST-BOUND-ACCOUNT"), ConnectionCredentialLeakError);
  assert.equal(config.connectionAuth!.screenDiagnostic("failure TEST-BOUND-ACCOUNT"),
    "Needlefish withheld runner diagnostic: it contained a selected connection credential.");
  assert.equal(JSON.stringify(config).includes("TEST-BOUND-ACCOUNT"), false);
  assert.equal(JSON.stringify(reviewRuntime(config, null)).includes("TEST-BOUND-ACCOUNT"), false);
});

test("model selectors retain safe punctuation without relaxing other runtime identities", () => {
  const runtime = reviewRuntime(resolveRunnerConfig({ runner: "codex", model: "provider/model@2026-01-01#high" }), null);
  assert.deepEqual(runtime.model, { status: "known", value: "provider/model@2026-01-01#high" });
  assert.deepEqual(parseReviewRuntime(JSON.parse(JSON.stringify(runtime))).model,
    { status: "known", value: "provider/model@2026-01-01#high" });
  assert.deepEqual(parseReviewRuntime({ ...runtime, model: { status: "operator_attested", value: "provider/model@2026-01-01" } }).model,
    { status: "operator_attested", value: "provider/model@2026-01-01" });
  for (const field of ["coreVersion", "sourceSha", "runnerVersion", "launcherDigest", "effort", "promptHash"] as const) {
    assert.deepEqual(parseReviewRuntime({ ...runtime, [field]: { status: "known", value: "identity@revision" } })[field],
      { status: "unknown" });
  }
});

test("timeout configuration rejects values the runtime cache cannot read", (t) => {
  assert.equal(parsePositiveInteger(String(Number.MAX_SAFE_INTEGER), "NEEDLEFISH_TIMEOUT_MS"), Number.MAX_SAFE_INTEGER);
  assert.throws(() => parsePositiveInteger("9007199254740992", "NEEDLEFISH_TIMEOUT_MS"), /NEEDLEFISH_TIMEOUT_MS.*safe integer/);
  assert.throws(() => parsePositiveInteger("9007199254740992", "NEEDLEFISH_REVIEW_TIMEOUT_MS"), /NEEDLEFISH_REVIEW_TIMEOUT_MS.*safe integer/);
  environment(t, { NEEDLEFISH_TIMEOUT_MS: "9007199254740992" });
  assert.throws(() => resolveRunnerConfig({ runner: "codex" }), /NEEDLEFISH_TIMEOUT_MS.*safe integer/);
  assert.throws(() => resolveRunnerConfig({ runner: "codex", timeoutMs: 9007199254740992 }), /timeoutMs.*safe integer/);
});

test("source identity accepts both operator release formats", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(sourceShaFromRelease({ sha }), { status: "operator_attested", value: sha });
  assert.deepEqual(sourceShaFromRelease({ base_sha: sha, self_version: "self", patch_sha256: "b".repeat(64), dependency_lock_sha256: "c".repeat(64) }),
    { status: "operator_attested", value: sha });
  assert.deepEqual(sourceShaFromRelease({ base_sha: "invalid" }), { status: "unknown" });
});

test("runtime never publishes endpoints, home paths or passthrough environment", (t) => {
  const endpoint = new URL("https://private.example/path");
  endpoint.username = "user";
  endpoint.password = "sentinel";
  endpoint.searchParams.set("credential", "query-sentinel");
  environment(t, {
    NEEDLEFISH_MODEL: undefined,
    NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "PRIVATE_SENTINEL",
    PRIVATE_SENTINEL: "passthrough-sentinel-value",
    UNRELATED_API_KEY: "opaque-credential-1234567890",
    OPENAI_BASE_URL: endpoint.href,
    NEEDLEFISH_ACP_BIN: "/Users/private-person/launcher",
  });
  for (const model of [
    endpoint.href,
    "https://private.example/model?credential=query-sentinel",
    "/Users/private-person/model",
    "/home/private-person/model",
    "C:\\Users\\private-person\\model",
    "~/private-model",
    "opaque-credential-1234567890",
    "provider/model@opaque-credential-1234567890",
    "provider/home/private-person/model@revision",
  ]) {
    const runtime = reviewRuntime(resolveRunnerConfig({ runner: "openai", model }), null);
    assert.deepEqual(runtime.model, { status: "unknown" });
    assert.deepEqual(parseReviewRuntime({ ...runtime, model: { status: "known", value: model } }).model, { status: "unknown" });
    assert.equal(JSON.stringify(runtime).includes("sentinel"), false);
    assert.equal(JSON.stringify(runtime).includes("private-person"), false);
    assert.equal(JSON.stringify(runtime).includes("private.example"), false);
  }
  const acp = reviewRuntime(resolveRunnerConfig({ runner: "acp" }), null);
  assert.equal(JSON.stringify(acp).includes("PRIVATE_SENTINEL"), false);
  assert.equal(JSON.stringify(acp).includes("passthrough-sentinel-value"), false);
  assert.deepEqual(acp.launcherDigest, { status: "unknown" });
  environment(t, { CODEX_PROXY_BASE_URL: endpoint.href, CODEX_PROXY_API_KEY: "proxy-sentinel", NEEDLEFISH_CODEX_PROXY_REQUIRED: "1" });
  const proxy = reviewRuntime(resolveRunnerConfig({ runner: "codex", model: "public-model" }), null);
  assert.deepEqual(proxy.model, { status: "known", value: "public-model" });
  assert.equal(JSON.stringify(proxy).includes("private.example"), false);
  assert.equal(JSON.stringify(proxy).includes("proxy-sentinel"), false);
});

test("a review freezes effective calls, round-trips runtime and keeps it out of prompts", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-runtime-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");
  commitAll(repo, "source");
  const bin = path.join(tmp, "runner.cjs");
  const capture = path.join(tmp, "calls.jsonl");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const prompt = fs.readFileSync(0, 'utf8');",
    `fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), prompt }) + '\\n');`,
    "console.log(JSON.stringify({type:'thread.started',thread_id:'frozen'}));",
    "console.log(JSON.stringify({type:'turn.started'}));",
    "console.log(JSON.stringify({type:'item.completed',item:{id:'answer',type:'agent_message',text:JSON.stringify({ summary: 'ok', findings: [], checked: ['source checked'], residual_risks: [] })}}));",
    "console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1,reasoning_output_tokens:0}}));",
  ].join("\n"));
  chmodSync(bin, 0o755);
  environment(t, {
    CODEX_BIN: bin, NEEDLEFISH_RUNNER: "codex", NEEDLEFISH_MODEL: "provider/model@2026-01-01",
    CODEX_REASONING_EFFORT: "medium", NEEDLEFISH_TIMEOUT_MS: "30000", NEEDLEFISH_REVIEW_TIMEOUT_MS: "60000",
    CODEX_PROXY_BASE_URL: undefined, CODEX_PROXY_API_KEY: undefined, NEEDLEFISH_CODEX_PROXY_REQUIRED: undefined,
    NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_NO_RETRY: "1",
  });
  const bundle: Bundle = {
    repoPath: repo, baseSha: headSha(repo), headSha: headSha(repo), patch: "short",
    patchStat: "app.ts | 1 +", changedFiles: [{ path: "app.ts", surface: "source" }],
    agentsMd: "(none)", prMeta: null, deep: false, focus: null,
  };
  const result = await review(bundle, { reasoningEffort: "high" }, undefined, () => {
    process.env.NEEDLEFISH_RUNNER = "acp";
    process.env.NEEDLEFISH_MODEL = "next-model";
    process.env.CODEX_REASONING_EFFORT = "xhigh";
    process.env.NEEDLEFISH_TIMEOUT_MS = "45000";
    process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "90000";
  });
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.runtime?.model, { status: "known", value: "provider/model@2026-01-01" });
  assert.deepEqual(result.runtime?.effort, { status: "known", value: "high" });
  assert.equal(result.runtime?.runner, "codex");
  assert.equal(result.runtime?.callTimeoutMs, 30000);
  assert.equal(result.runtime?.reviewBudgetMs, 60000);
  assert.deepEqual(result.stats?.map(({ runner, model }) => ({ runner, model })), [
    { runner: "codex", model: "provider/model@2026-01-01" }, { runner: "codex", model: "provider/model@2026-01-01" },
  ]);
  const calls: unknown = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(Array.isArray(calls));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(typeof call === "object" && call !== null && "args" in call && "prompt" in call);
    assert.ok(Array.isArray(call.args));
    assert.equal(call.args[call.args.indexOf("-m") + 1], "provider/model@2026-01-01");
    assert.deepEqual(call.args.filter((arg: unknown) => typeof arg === "string" && arg.startsWith("model_reasoning_effort=")), ['model_reasoning_effort="high"']);
    assert.equal(typeof call.prompt, "string");
    assert.equal(String(call.prompt).includes('"runtime"'), false);
    assert.equal(String(call.prompt).includes("launcherDigest"), false);
    assert.equal(String(call.prompt).includes("qualification"), false);
  }
  assert.deepEqual(parseReviewResult(JSON.parse(serializeReviewResult(result))), result);
  assert.match(renderMarkdown(result), /AI service codex/);
  assert.match(renderMarkdown(result), /Runtime technical data/);
  assert.equal(renderMarkdown(result, { omitRuntime: true }).includes("Runtime technical data"), false);
  const next = reviewRuntime(resolveRunnerConfig({}), null);
  assert.equal(next.runner, "acp");
  assert.deepEqual(next.model, { status: "unknown" });
  process.env.NEEDLEFISH_RUNNER = "codex";
  const nextCodex = reviewRuntime(resolveRunnerConfig({}), 90000);
  assert.deepEqual(nextCodex.model, { status: "known", value: "next-model" });
  assert.deepEqual(nextCodex.effort, { status: "known", value: "xhigh" });
  assert.equal(nextCodex.callTimeoutMs, 45000);
});

test("suspended OpenCode rejects a review before invoking its executable", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-runtime-opencode-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "opencode.cjs");
  const calls = path.join(tmp, "calls.txt");
  writeFileSync(bin, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(calls)}, 'called\\n');`,
    "setTimeout(() => process.stdout.write(JSON.stringify({ type: 'text', part: { text: JSON.stringify({ summary: 'ok', findings: [], checked: ['source checked'], residual_risks: [] }) } }) + '\\n'), 150);",
  ].join("\n"));
  chmodSync(bin, 0o755);
  environment(t, { OPENCODE_BIN: bin, OPENCODE_IDLE_TIMEOUT_MS: "1500", NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_NO_RETRY: "1" });
  await assert.rejects(review({
    repoPath: repo, baseSha: headSha(repo), headSha: headSha(repo), patch: "short", patchStat: "app.ts | 1 +",
    changedFiles: [{ path: "app.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null,
  }, { runner: "opencode", timeoutMs: 5000 }), /OpenCode reviews are temporarily disabled/);
  assert.equal(existsSync(calls), false);
});

for (const namedLaunch of [false, true]) {
  test(`ACP review runtime stays unknown with named launch=${namedLaunch}`, async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-runtime-acp-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const repo = initRepo(tmp);
    const bin = path.join(tmp, "agent.cjs");
    const capture = path.join(tmp, "requests.jsonl");
    const launches = path.join(tmp, "launches.jsonl");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(launches)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
      "const rl = require('node:readline').createInterface({ input: process.stdin });",
      "const send = value => process.stdout.write(JSON.stringify(value) + '\\n');",
      "rl.on('line', line => {",
      `  fs.appendFileSync(${JSON.stringify(capture)}, line + '\\n');`,
      "  const request = JSON.parse(line);",
      "  let result = {};",
      "  if (request.method === 'initialize') result = { protocolVersion: 1, agentCapabilities: {} };",
      "  if (request.method === 'session/new') result = { sessionId: 'sess' };",
      "  if (request.method === 'session/prompt') {",
      "    const text = JSON.stringify({ summary: 'ok', findings: [], checked: ['ACP reviewed'], residual_risks: [] });",
      "    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });",
      "    result = { stopReason: 'end_turn' };",
      "  }",
      "  if (request.method === 'initialize') setTimeout(() => send({ jsonrpc: '2.0', id: request.id, result }), 150);",
      "  else send({ jsonrpc: '2.0', id: request.id, result });",
      "});",
    ].join("\n"));
    chmodSync(bin, 0o755);
    environment(t, { NEEDLEFISH_ACP_BIN: namedLaunch ? path.join(tmp, "wrong-agent") : bin, NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS: "1500", NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_NO_RETRY: "1" });
    const result = await review({
      repoPath: repo, baseSha: headSha(repo), headSha: headSha(repo), patch: "short", patchStat: "app.ts | 1 +",
      changedFiles: [{ path: "app.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null,
    }, { runner: "acp", model: namedLaunch ? "selected-model" : "caller-guess", reasoningEffort: "high", timeoutMs: 5000,
      ...(namedLaunch ? { acpLaunch: { command: bin, args: ["--model", "selected-model"] } } : {}),
    }, undefined, () => { process.env.NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS = "1"; });
    assert.equal(result.verdict, "pass");
    assert.equal(result.runtime?.runner, "acp");
    assert.deepEqual(result.runtime?.model, { status: "unknown" });
    assert.deepEqual(result.runtime?.effort, { status: "unknown" });
    const requests = readFileSync(capture, "utf8");
    assert.equal(requests.includes("caller-guess"), false);
    assert.equal(requests.includes("launcherDigest"), false);
    assert.deepEqual(result.stats?.map((stat) => stat.model), namedLaunch ? ["selected-model", "selected-model"] : [undefined, undefined]);
    assert.deepEqual(readFileSync(launches, "utf8").trim().split("\n").map((line) => JSON.parse(line)),
      namedLaunch ? [["--model", "selected-model"], ["--model", "selected-model"]] : [[], []]);
  });
}

for (const scenario of [
  { name: "provider", provider: "next-provider", authMode: "oauth", initialAuthMode: "oauth", stagedAuth: true },
  { name: "OAuth mode", provider: "initial-provider", authMode: "proxy", initialAuthMode: "oauth", stagedAuth: true },
  { name: "proxy mode", provider: "initial-provider", authMode: "oauth", initialAuthMode: "proxy", stagedAuth: false },
]) {
  test(`Pi review freezes ${scenario.name} before progress callbacks`, async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-runtime-pi-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const repo = initRepo(tmp);
    const fakeHome = path.join(tmp, "source-home");
    const authDir = path.join(fakeHome, ".pi", "agent");
    mkdirSync(authDir, { recursive: true });
    writeFileSync(path.join(authDir, "models.json"), "{}");
    writeFileSync(path.join(authDir, "auth.json"), JSON.stringify({
      "initial-provider": { type: "oauth", access: "initial-sentinel" },
      "next-provider": { type: "oauth", access: "next-sentinel" },
    }));
    const bin = path.join(tmp, "pi.cjs");
    const capture = path.join(tmp, "calls.jsonl");
    writeFileSync(bin, [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "fs.readFileSync(0, 'utf8');",
      "const authFile = path.join(process.env.HOME, '.pi', 'agent', 'auth.json');",
      "const auth = fs.existsSync(authFile) ? JSON.parse(fs.readFileSync(authFile, 'utf8')) : null;",
      `fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args: process.argv.slice(2), auth }) + '\\n');`,
      "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['Pi checked'], residual_risks: [] }));",
    ].join("\n"));
    chmodSync(bin, 0o755);
    environment(t, {
      PI_BIN: bin, PI_PROVIDER: "initial-provider", PI_AUTH_MODE: scenario.initialAuthMode,
      HOME: fakeHome, NEEDLEFISH_EPHEMERAL_HOME: "1", NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_NO_RETRY: "1",
      NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: undefined,
    });
    const result = await review({
      repoPath: repo, baseSha: headSha(repo), headSha: headSha(repo), patch: "short", patchStat: "app.ts | 1 +",
      changedFiles: [{ path: "app.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null,
    }, { runner: "pi", timeoutMs: 5000 }, undefined, () => {
      process.env.PI_PROVIDER = scenario.provider;
      process.env.PI_AUTH_MODE = scenario.authMode;
    });
    assert.equal(result.verdict, "pass");
    assert.equal(result.runtime?.runner, "pi");
    const calls: unknown = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(Array.isArray(calls));
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.ok(typeof call === "object" && call !== null && "args" in call && "auth" in call);
      assert.ok(Array.isArray(call.args));
      assert.equal(call.args[call.args.indexOf("--provider") + 1], "initial-provider");
      assert.deepEqual(call.auth, scenario.stagedAuth ? { "initial-provider": { type: "oauth", access: "initial-sentinel" } } : null);
    }
    const published = serializeReviewResult(result) + renderMarkdown(result);
    for (const privateValue of ["initial-provider", "next-provider", "initial-sentinel", "next-sentinel", fakeHome]) {
      assert.equal(published.includes(privateValue), false);
    }
  });
}

test("Codex capture preserves Windows case-insensitive PATH and declared passthrough", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-native-path-casing-"));
  isolateCodexTestHome(t, tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(platform);
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  t.after(() => Object.defineProperty(process, "platform", platform));
  environment(t, { PATH: undefined, Path: "C:\\tools", CODEX_BIN: "/missing-codex", NEEDLEFISH_EPHEMERAL_HOME: undefined, NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "MiXeD_KEY", MiXeD_KEY: undefined, MIXED_KEY: "synthetic-case-control", CODEX_PROXY_BASE_URL: undefined, CODEX_PROXY_API_KEY: undefined, NEEDLEFISH_CODEX_PROXY_REQUIRED: undefined });
  const config = resolveRunnerConfig({ runner: "codex" });
  const child = buildRunnerEnv("codex", "/empty-gh", undefined, undefined, capturedCodexEnvironment(config));
  assert.equal(child.PATH, "C:\\tools");
  assert.equal(child.MiXeD_KEY, "synthetic-case-control");
  assert.equal(JSON.stringify(config).includes("synthetic-case-control"), false);
});

for (const windows of [false, true]) {
  test(`native Codex artifact and API-key passthrough respect platform casing windows=${windows}`, t => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-native-casing-"));
    isolateCodexTestHome(t, tmp);
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    assert.ok(platform);
    t.after(() => { Object.defineProperty(process, "platform", platform); rmSync(tmp, { recursive: true, force: true }); });
    const binary = path.join(tmp, "codex.exe");
    writeFileSync(binary, "MZsynthetic-native-artifact");
    chmodSync(binary, 0o755);
    Object.defineProperty(process, "platform", { ...platform, value: windows ? "win32" : "darwin" });
    assert.equal(codexAuthRoot({ HOME: "synthetic-home", USERPROFILE: "synthetic-profile" }), path.join(windows ? "synthetic-profile" : "synthetic-home", ".codex"));
    if (windows) assert.match(publicNativeCodexDigest(binary, { Codex_Bin: binary }), /^sha256:[a-f0-9]{64}$/);
    else assert.throws(() => publicNativeCodexDigest(binary, { Codex_Bin: binary }), /configured readable/);
    environment(t, { HOME: tmp, USERPROFILE: tmp, CODEX_BIN: binary, CODEX_HOME: undefined, NEEDLEFISH_EPHEMERAL_HOME: "1", NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "codex_api_key", CODEX_API_KEY: "synthetic-case-auth", codex_api_key: undefined, CODEX_PROXY_BASE_URL: undefined, CODEX_PROXY_API_KEY: undefined, NEEDLEFISH_CODEX_PROXY_REQUIRED: undefined });
    const config = resolveRunnerConfig({ runner: "codex" });
    if (windows) {
      const home = prepareCapturedCodexHome(config, tmp);
      assert.equal(home, path.join(tmp, "home"));
      const child = buildRunnerEnv("codex", path.join(tmp, "gh"), home, undefined, capturedCodexEnvironment(config));
      assert.equal(child.codex_api_key, "synthetic-case-auth");
      assert.equal(child.CODEX_HOME, path.join(tmp, "home", ".codex"));
    } else assert.throws(() => prepareCapturedCodexHome(config, tmp), /required auth source/);
  });
}

for (const auth of ["proxy", "api-key", "auth-files"] as const) {
  test(`captured Codex ${auth} home satisfies strict CLI startup without ambient auth fallback`, t => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-codex-home-startup-"));
    isolateCodexTestHome(t, tmp);
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const original = path.join(tmp, ".codex");
    mkdirSync(original, { mode: 0o700 });
    writeFileSync(path.join(original, "auth.json"), '{"synthetic":"owned-auth-control"}');
    writeFileSync(path.join(original, "config.toml"), 'model = "owned-config-control"');
    environment(t, {
      CODEX_BIN: process.execPath,
      NEEDLEFISH_EPHEMERAL_HOME: "1",
      NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: auth === "api-key" ? "CODEX_API_KEY" : undefined,
      CODEX_API_KEY: auth === "api-key" ? "synthetic-owned-api-key" : undefined,
      CODEX_PROXY_BASE_URL: auth === "proxy" ? "http://127.0.0.1:1/v1" : undefined,
      CODEX_PROXY_API_KEY: auth === "proxy" ? "synthetic-owned-proxy-key" : undefined,
      NEEDLEFISH_CODEX_PROXY_REQUIRED: auth === "proxy" ? "1" : undefined,
    });
    const config = resolveRunnerConfig({ runner: "codex" });
    const home = prepareCapturedCodexHome(config, tmp);
    const env = buildRunnerEnv("codex", path.join(tmp, "gh"), home, undefined, capturedCodexEnvironment(config));
    const codexHome = env.CODEX_HOME;
    assert.equal(codexHome, path.join(tmp, "home", ".codex"));
    assert.ok(codexHome);
    const startup = spawnSync(process.execPath, ["-e", `
      const fs = require("node:fs");
      const path = require("node:path");
      const home = process.env.CODEX_HOME;
      const info = fs.statSync(home);
      if (!info.isDirectory()) process.exit(2);
      process.stdout.write(JSON.stringify({
        mode: info.mode & 0o777,
        auth: fs.existsSync(path.join(home, "auth.json")),
        config: fs.existsSync(path.join(home, "config.toml")),
      }));
    `], { env, encoding: "utf8" });
    assert.equal(startup.status, 0, startup.stderr);
    assert.deepEqual(JSON.parse(startup.stdout), { mode: 0o700, auth: auth === "auth-files", config: auth === "auth-files" });
    assert.equal(readFileSync(path.join(original, "auth.json"), "utf8"), '{"synthetic":"owned-auth-control"}');
    assert.equal(readFileSync(path.join(original, "config.toml"), "utf8"), 'model = "owned-config-control"');
    if (auth === "auth-files") {
      assert.equal(readFileSync(path.join(codexHome, "auth.json"), "utf8"), '{"synthetic":"owned-auth-control"}');
      assert.equal(readFileSync(path.join(codexHome, "config.toml"), "utf8"), 'model = "owned-config-control"');
    }
  });
}

test("Codex fixture rejects auth/config reads outside its owned root", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nf-native-home-guard-"));
  isolateCodexTestHome(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, "auth.json"), "synthetic-owned-auth");
  assert.equal(readFileSync(path.join(root, "auth.json"), "utf8"), "synthetic-owned-auth");
  for (const filename of ["auth.json", "config.toml"]) assert.throws(() => readFileSync(path.join(root, "..", "outside-owned-control", filename)), { message: "Codex test attempted to read auth/config outside its owned root" });
});

test("Codex public projection omits unused homes and withholds unsafe selectors", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "nf-native-projection-"));
  isolateCodexTestHome(t, root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const project = (environment: NodeJS.ProcessEnv) => codexPublicEnvironment(environment, null, null, `sha256:${"a".repeat(64)}`);
  assert.equal(project({ CODEX_HOME: root }), project({}));
  assert.equal(project({ CODEX_HOME: root, NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "CODEX_HOME" }).includes('["CODEX_HOME","<required>"]'), true);
  for (const value of ["https://example.invalid/private", "synthetic-private-token"]) {
    const actual = project({ CODEX_MODEL: value, CODEX_API_KEY: "synthetic-private-token" });
    assert.equal(actual.includes(value), false);
    assert.equal(actual.includes('["CODEX_MODEL","<required>"]'), true);
  }
  assert.equal(project({ CODEX_MODEL: "public-model" }).includes('["CODEX_MODEL","public-model"]'), true);
});
