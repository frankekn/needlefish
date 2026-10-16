import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { review } from "../core/review";
import { promptHash } from "./prompt-hash";
import { resolveRunnerConfig } from "./codex";
import { commitAll, headSha, initRepo } from "./codex-runner-test-fixtures";
import { renderMarkdown } from "./render";
import { parseReviewResult } from "./review-result";
import { parseReviewRuntime, reviewRuntime } from "./runtime";
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
  assert.deepEqual(reviewRuntime(resolveRunnerConfig({ runner: "opencode", model: "provider/model#low", reasoningEffort: "high" }), null).model, { status: "known", value: "provider/model#high" });
  assert.throws(() => parseReviewRuntime({ ...acp, qualification: { matchStatus: "tested" } }), /qualification/);
  assert.deepEqual(parseReviewRuntime({ ...acp, runnerVersion: { status: "operator_attested", value: "1.2.3" } }).runnerVersion, { status: "operator_attested", value: "1.2.3" });
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
  ]) {
    const runtime = reviewRuntime(resolveRunnerConfig({ runner: "openai", model }), null);
    assert.deepEqual(runtime.model, { status: "unknown" });
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
    "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['source checked'], residual_risks: [] }));",
  ].join("\n"));
  chmodSync(bin, 0o755);
  environment(t, {
    CODEX_BIN: bin, NEEDLEFISH_RUNNER: "codex", NEEDLEFISH_MODEL: "first-model",
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
  assert.deepEqual(result.runtime?.model, { status: "known", value: "first-model" });
  assert.deepEqual(result.runtime?.effort, { status: "known", value: "high" });
  assert.equal(result.runtime?.runner, "codex");
  assert.equal(result.runtime?.callTimeoutMs, 30000);
  assert.equal(result.runtime?.reviewBudgetMs, 60000);
  assert.deepEqual(result.stats?.map(({ runner, model }) => ({ runner, model })), [
    { runner: "codex", model: "first-model" }, { runner: "codex", model: "first-model" },
  ]);
  const calls: unknown = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(Array.isArray(calls));
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.ok(typeof call === "object" && call !== null && "args" in call && "prompt" in call);
    assert.ok(Array.isArray(call.args));
    assert.equal(call.args[call.args.indexOf("-m") + 1], "first-model");
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
      "  send({ jsonrpc: '2.0', id: request.id, result });",
      "});",
    ].join("\n"));
    chmodSync(bin, 0o755);
    environment(t, { NEEDLEFISH_ACP_BIN: namedLaunch ? path.join(tmp, "wrong-agent") : bin, NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_NO_RETRY: "1" });
    const result = await review({
      repoPath: repo, baseSha: headSha(repo), headSha: headSha(repo), patch: "short", patchStat: "app.ts | 1 +",
      changedFiles: [{ path: "app.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null,
    }, { runner: "acp", model: namedLaunch ? "selected-model" : "caller-guess", reasoningEffort: "high", timeoutMs: 5000,
      ...(namedLaunch ? { acpLaunch: { command: bin, args: ["--model", "selected-model"] } } : {}),
    });
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
