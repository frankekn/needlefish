import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspect } from "node:util";
import { executableNames } from "../../src/shared/runner-detection";
import { acpRuntimeIdentity, matchRuntimeIdentity, parsePublicRuntimeIdentity, publicLauncherCandidates } from "./runtime-identity";
import { matchQualifiedConfiguration } from "./runtime-qualification";
import { comparisonEnvironmentError, runnerEnvironmentAttestationError } from "./report-integrity";
import { renderResults } from "../gen-results";
import { score } from "./score";
import { compare, parseArgs, resumeSlots, runnerEnvironment, writeReport } from "../run";

function launcher() {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-public-launcher-"));
  const file = path.join(root, "launcher");
  writeFileSync(file, "#!/bin/sh\nexit 0\n");
  chmodSync(file, 0o755);
  return { root, file };
}

test("ACP identity measures only the declared public configured executable and preserves provenance", (t) => {
  const { root, file } = launcher();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const environment = { NEEDLEFISH_ACP_BIN: file, NEEDLEFISH_ACP_AUTH_ENV_VARS: "TEST_AGENT_TOKEN" };
  const identity = acpRuntimeIdentity(file, environment, "Agent 1.2.3");
  assert.deepEqual(identity, {
    version: 1,
    launcherDigest: { status: "known", value: `sha256:${createHash("sha256").update(readFileSync(file)).digest("hex")}` },
    harnessVersion: { status: "operator_attested", value: "Agent 1.2.3" },
    authSource: { status: "operator_attested", value: "environment" },
  });
  assert.equal(matchRuntimeIdentity(identity, parsePublicRuntimeIdentity(JSON.parse(JSON.stringify(identity)))), "exact");
  writeFileSync(file, "#!/bin/sh\nexit 1\n");
  assert.equal(matchRuntimeIdentity(acpRuntimeIdentity(file, environment, "Agent 1.2.3"), identity), "different");
  assert.equal(matchRuntimeIdentity(acpRuntimeIdentity(null, environment, "Agent 1.2.3"), identity), "unknown");
  assert.throws(() => acpRuntimeIdentity(file, { ...environment, NEEDLEFISH_ACP_BIN: process.execPath }, "Agent 1.2.3"), /must be the configured ACP executable/);
  assert.throws(() => acpRuntimeIdentity(file, { ...environment, NEEDLEFISH_ACP_BIN: "relative/launcher" }, "Agent 1.2.3"), /must be the configured ACP executable/);
  assert.throws(() => acpRuntimeIdentity(file, { ...environment, NEEDLEFISH_ACP_BIN: "launcher", PATH: `.${path.delimiter}${root}` }, "Agent 1.2.3"), /must be the configured ACP executable/);
  const earlier = path.join(root, "earlier");
  mkdirSync(earlier);
  writeFileSync(path.join(earlier, "launcher"), "#!/bin/sh\nexit 2\n");
  chmodSync(path.join(earlier, "launcher"), 0o755);
  assert.throws(() => acpRuntimeIdentity(file, { ...environment, NEEDLEFISH_ACP_BIN: "launcher", PATH: `${earlier}${path.delimiter}${root}` }, "Agent 1.2.3"), /must be the configured ACP executable/);
});

test("public identity cannot contain endpoints, home paths, env values or secret digests", () => {
  const url = new URL("https://example.invalid");
  url.username = "user";
  url.password = "synthetic-value";
  url.searchParams.set("token", "synthetic-query");
  for (const unsafe of [url.href, "/Users/private/launcher", "/home/private/launcher", "TOKEN=synthetic-value"]) {
    const identity = acpRuntimeIdentity(null, { NEEDLEFISH_ACP_AUTH_ENV_VARS: "TOKEN", TOKEN: unsafe }, unsafe);
    assert.deepEqual(identity.harnessVersion, { status: "unknown" });
    assert.deepEqual(identity.authSource, { status: "operator_attested", value: "environment" });
    assert.equal(JSON.stringify(identity).includes(unsafe), false);
  }
  assert.throws(() => acpRuntimeIdentity("/Users/private/missing", { NEEDLEFISH_ACP_BIN: "/Users/private/missing" }, null), { message: "public launcher artifact must be the configured ACP executable and readable" });
  assert.throws(() => parsePublicRuntimeIdentity({ version: 1, launcherDigest: { status: "known", value: "sha256:short" }, harnessVersion: { status: "unknown" }, authSource: { status: "unknown" } }), /launcher digest/);
});

test("eval identity freezes launcher bytes, keeps private refusals and matches complete configuration only", (t) => {
  const { root, file } = launcher();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const args = parseArgs(["--runner", "acp", "--public-launcher-artifact", file, "--provider", "Public provider", "--route", "public", "--runner-version", "Agent 1.2.3", "--model", "public-model", "--effort", "high", "--report", path.join(root, "report.json"), "--env", `NEEDLEFISH_ACP_BIN=${file}`, "--env", "NEEDLEFISH_ACP_AUTH_ENV_VARS=TOKEN", "--env", "TOKEN=synthetic-value"]);
  const identity = runnerEnvironment(args);
  assert.equal(identity.includes("synthetic-value"), false);
  args.environmentIdentity = identity;
  const privateReport = writeReport(args, [], []);
  assert.equal(privateReport.privateEnvironment, true);
  assert.equal(runnerEnvironmentAttestationError(privateReport), "public lanes require a public runner-environment attestation");
  assert.equal(matchQualifiedConfiguration(privateReport, privateReport), "unknown");
  const publicEnvironment = JSON.stringify([
    ["NEEDLEFISH_EPHEMERAL_HOME", "1"], ["NEEDLEFISH_EVAL_TRACE", "1"],
    ["ACP_PUBLIC_RUNTIME", JSON.stringify(acpRuntimeIdentity(file, { NEEDLEFISH_ACP_BIN: file, NEEDLEFISH_ACP_AUTH_ENV_VARS: "TOKEN" }, "Agent 1.2.3"))],
  ]);
  const publicReport = { ...privateReport, anticheatVersion: 2, privateEnvironment: false, runnerEnvironment: publicEnvironment };
  assert.equal(matchQualifiedConfiguration(publicReport, publicReport), "exact");
  assert.equal(matchQualifiedConfiguration({ ...publicReport, model: "different" }, publicReport), "different");
  assert.equal(matchQualifiedConfiguration({ ...publicReport, scorerHash: "changed" }, publicReport), "different");
  assert.equal(matchQualifiedConfiguration({ ...publicReport, gitSha: undefined }, publicReport), "unknown");
  assert.equal(matchQualifiedConfiguration({ ...publicReport, runnerEnvironment: "[]" }, publicReport), "unknown");
  writeFileSync(file, "#!/bin/sh\nexit 1\n");
  assert.throws(() => runnerEnvironment(args), /environment changed during the eval run/);
  assert.throws(() => parseArgs(["--runner", "codex", "--public-launcher-artifact", file]), /requires --runner acp/);
});

test("eval metadata labels reject private URLs and home paths before reports or diagnostics", () => {
  const url = new URL("https://example.invalid");
  url.username = "test-user";
  url.password = "synthetic-password";
  url.searchParams.set("token", "synthetic-query");
  for (const value of [url.href, "/Users/private/provider", "/home/private/provider", "/root/.config/provider", "/private/var/folders/private-provider", "C:\\Users\\private\\provider", "~/private-provider"]) {
    assert.throws(() => parseArgs(["--provider", value, "--route", "public", "--runner-version", "Agent 1.2.3"]), { message: "--provider requires a public label, not a private endpoint or path" });
  }
});

test("private Pi auth-store changes are detected in memory without publishing its identity", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-private-auth-identity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  const args = parseArgs(["--runner", "pi", "--env", `HOME=${root}`, "--env", "PI_AUTH_MODE=oauth", "--env", "PI_PROVIDER=selected"]);
  const missing = runnerEnvironment(args);
  args.environmentIdentity = missing;
  writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ selected: { type: "oauth", access: "SYNTHETIC-FIRST" } }));
  assert.throws(() => runnerEnvironment(args), { message: "runner environment changed during the eval run" });
  args.environmentIdentity = null;
  const initial = runnerEnvironment(args);
  args.environmentIdentity = initial;
  writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ selected: { type: "oauth", access: "SYNTHETIC-FIRST" }, unrelated: { type: "oauth", access: "SYNTHETIC-OTHER" } }));
  assert.equal(runnerEnvironment(args), initial);
  assert.equal(initial.includes("SYNTHETIC-FIRST"), false);
  assert.equal(initial.includes(createHash("sha256").update(JSON.stringify({ type: "oauth", access: "SYNTHETIC-FIRST" })).digest("hex")), false);
  assert.equal(new Map<string, string>(JSON.parse(initial)).get("PI_AUTH_JSON"), "<required>");
  writeFileSync(path.join(directory, "auth.json"), JSON.stringify({ selected: { type: "oauth", access: "SYNTHETIC-SECOND" } }));
  assert.throws(() => runnerEnvironment(args), { message: "runner environment changed during the eval run" });
});

test("identical private placeholders cannot authorize cross-report comparison or resume", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-private-comparison-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "models.json");
  const spec = { id: "private-comparison", kind: "negative" as const, defectClass: "clean", description: "private identity comparison", baseFiles: { "src/value.ts": "export const value = 1;" }, headFiles: { "src/value.ts": "export const value = 2;" }, expected: { verdict: "pass" as const } };
  const buildArgs = (report: string, resume?: string) => parseArgs(["--runner", "pi", "--model", "test-model", "--effort", "high", "--provider", "Pi test", "--route", "private-test", "--runner-version", "Pi 1.0", "--env", `HOME=${root}`, "--env", "PI_AUTH_MODE=proxy", "--env", "PI_PROVIDER=test", "--report", report, ...(resume ? ["--resume", resume] : [])]);
  const firstPath = path.join(root, "first.json");
  writeFileSync(file, JSON.stringify({ providers: { test: { apiKey: "SYNTHETIC-ONE" } } }));
  const draw = { fixtureId: spec.id, draw: 0, score: score({ verdict: "pass", findings: [] }, spec.expected, spec.id), durationMs: 1, calls: 1, retries: 0 };
  const first = { ...writeReport(buildArgs(firstPath), [draw], [spec]), anticheatVersion: 2 };
  writeFileSync(firstPath, JSON.stringify(first));
  for (const [label, secret] of [["same", "SYNTHETIC-ONE"], ["different", "SYNTHETIC-TWO"]]) {
    writeFileSync(file, JSON.stringify({ providers: { test: { apiKey: secret } } }));
    const args = buildArgs(path.join(root, label + ".json"), firstPath);
    const next = { ...writeReport(args, [draw], [spec]), anticheatVersion: 2 };
    assert.equal(next.runnerEnvironment, first.runnerEnvironment);
    assert.equal(next.privateEnvironment, true);
    assert.equal(comparisonEnvironmentError(next), "private runner environment identity");
    assert.throws(() => compare(firstPath, next), { message: "baseline report has private runner environment identity; cross-report comparison is unavailable." });
    assert.equal(resumeSlots(args, [spec], [{ spec, draw: 0 }]).skipped, 0);
    assert.match(renderResults([spec], [{ stem: "first", report: first }, { stem: label, report: next }]), /No guarded report qualifies as a baseline/);
  }
  assert.equal(comparisonEnvironmentError({ runnerEnvironment: '[["PRIVATE_CONFIG","<required>"]]', privateEnvironment: false }), "private runner environment identity");
  assert.equal(comparisonEnvironmentError({ runnerEnvironment: "malformed" }), "unknown runner environment identity");
  assert.equal(comparisonEnvironmentError({ runnerEnvironment: '[["NEEDLEFISH_EPHEMERAL_HOME","1"]]', privateEnvironment: false }), null);
});

test("private identity read failures never expose auth contents or HOME through causes", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-private-error-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  const args = parseArgs(["--runner", "pi", "--env", `HOME=${root}`, "--env", "PI_PROVIDER=private-fixture", "--env", "PI_AUTH_MODE=oauth"]);
  writeFileSync(path.join(directory, "auth.json"), '{"private-fixture":{"access":"SYNTHETIC-SECRET"');
  assert.throws(() => runnerEnvironment(args), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "private runner authentication identity is unreadable");
    assert.equal(inspect(error).includes("SYNTHETIC-SECRET"), false);
    assert.equal(inspect(error).includes(root), false);
    return true;
  });
  rmSync(path.join(directory, "auth.json"));
  mkdirSync(path.join(directory, "models.json"));
  assert.throws(() => runnerEnvironment(args), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "private runner configuration identity is unreadable");
    assert.equal(inspect(error).includes(root), false);
    return true;
  });
});

test("all attestation labels reject credential values from eval overrides", () => {
  for (const flag of ["--provider", "--route", "--runner-version"]) {
    const values = { "--provider": "Public provider", "--route": "public", "--runner-version": "Agent 1.2.3", [flag]: "SYNTHETIC-PRIVATE-LABEL" };
    const args = Object.entries(values).flatMap(([key, value]) => [key, value]);
    for (const secret of ["SYNTHETIC-PRIVATE-LABEL", "  SYNTHETIC-PRIVATE-LABEL  "]) {
      assert.throws(() => parseArgs([...args, "--env", `TEST_ATTESTATION_TOKEN=${secret}`]), { message: `${flag} requires a public label, not a private endpoint or path` });
    }
  }
});

test("nested unknown ACP metadata cannot authorize comparison, resume or a delta baseline", (t) => {
  const keys = ["NEEDLEFISH_ACP_AUTH_ENV_VARS", "NEEDLEFISH_ACP_AUTH_FILES", "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-unknown-acp-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "unknown.json");
  const spec = { id: "unknown-acp", kind: "negative" as const, defectClass: "clean", description: "unknown ACP identity", baseFiles: { "src/value.ts": "export const value = 1;" }, headFiles: { "src/value.ts": "export const value = 2;" }, expected: { verdict: "pass" as const } };
  const args = parseArgs(["--runner", "acp", "--model", "test-model", "--effort", "high", "--provider", "Public test", "--route", "public", "--runner-version", "Agent 1.2.3", "--env", "NEEDLEFISH_ACP_BIN=public-launcher", "--report", target]);
  const draw = { fixtureId: spec.id, draw: 0, score: score({ verdict: "pass", findings: [] }, spec.expected, spec.id), durationMs: 1, calls: 1, retries: 0 };
  const report = { ...writeReport(args, [draw], [spec]), anticheatVersion: 2 };
  assert.equal(report.privateEnvironment, false);
  assert.equal(comparisonEnvironmentError(report), "unknown runner environment identity");
  writeFileSync(target, JSON.stringify(report));
  assert.throws(() => compare(target, report), { message: "baseline report has unknown runner environment identity; cross-report comparison is unavailable." });
  args.resume = target;
  assert.equal(resumeSlots(args, [spec], [{ spec, draw: 0 }]).skipped, 0);
  assert.match(renderResults([spec], [{ stem: "unknown-acp", report }]), /No guarded report qualifies as a baseline/);
  assert.equal(comparisonEnvironmentError({ runner: "acp" }), "unknown runner environment identity");
  const complete = { version: 1, launcherDigest: { status: "known", value: `sha256:${"a".repeat(64)}` }, harnessVersion: { status: "operator_attested", value: "Agent 1.2.3" }, authSource: { status: "operator_attested", value: "environment" } };
  const environment = (identity: unknown) => JSON.stringify([["ACP_PUBLIC_RUNTIME", JSON.stringify(identity)]]);
  assert.equal(comparisonEnvironmentError({ runner: "acp", runnerEnvironment: environment(complete) }), null);
  for (const key of ["launcherDigest", "harnessVersion", "authSource"]) {
    assert.equal(comparisonEnvironmentError({ runner: "acp", runnerEnvironment: environment({ ...complete, [key]: { status: "unknown" } }) }), "unknown runner environment identity");
  }
});

test("declared ACP and passthrough credentials are screened independently of variable spelling", () => {
  for (const [declaration, name, value] of [["NEEDLEFISH_ACP_AUTH_ENV_VARS", "SESSION", "abc"], ["NEEDLEFISH_RUNNER_ENV_PASSTHROUGH", "PRIVATE_SETTING", "private-value"]]) {
    for (const flag of ["--provider", "--route", "--runner-version"]) {
      const labels = { "--provider": "Public provider", "--route": "public", "--runner-version": "Agent 1.2.3", [flag]: value };
      assert.throws(() => parseArgs([...Object.entries(labels).flatMap(([key, label]) => [key, label]), "--env", `${declaration}=${name}`, "--env", `${name}=${value}`]), { message: `${flag} requires a public label, not a private endpoint or path` });
    }
  }
  assert.throws(() => parseArgs(["--provider", ".agent/auth.json", "--route", "public", "--runner-version", "Agent 1.2.3", "--env", "NEEDLEFISH_ACP_AUTH_FILES=.agent/auth.json"]), { message: "--provider requires a public label, not a private endpoint or path" });
});

test("ACP artifact lookup shares platform executable names with runner detection", (t) => {
  const previousPathExt = process.env.PATHEXT;
  delete process.env.PATHEXT;
  t.after(() => { if (previousPathExt === undefined) delete process.env.PATHEXT; else process.env.PATHEXT = previousPathExt; });
  assert.deepEqual(executableNames("agent", "win32", ".EXE;.CMD"), ["agent", "agent.EXE", "agent.CMD"]);
  assert.deepEqual(executableNames("agent", "win32", undefined), ["agent", "agent.COM", "agent.EXE", "agent.BAT", "agent.CMD"]);
  assert.deepEqual(executableNames("agent.exe", "win32", ".EXE;.CMD"), ["agent.exe"]);
  assert.deepEqual(executableNames("agent", "linux", ".EXE;.CMD"), ["agent"]);
});


test("public launcher metadata follows Windows Path casing", () => {
  assert.deepEqual(publicLauncherCandidates({ needlefish_acp_bin: "agent", Path: "C:\\Bin;D:\\Other", PathExt: ".EXE;.CMD" }, "win32"), [
    "C:\\Bin\\agent", "C:\\Bin\\agent.EXE", "C:\\Bin\\agent.CMD",
    "D:\\Other\\agent", "D:\\Other\\agent.EXE", "D:\\Other\\agent.CMD",
  ]);
});

test("public launcher metadata rejects either Windows relative separator", () => {
  for (const command of ["relative/agent", "relative\\agent"]) {
    assert.throws(() => publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: command, PATH: "C:\\Bin" }, "win32"), /depends on the target working directory/);
  }
  assert.throws(() => publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "agent", Path: ".;C:\\Bin" }, "win32"), /depends on the target working directory/);
});

test("Windows public launcher metadata rejects paths that depend on the current drive", () => {
  for (const command of ["/agent", "\\agent", "C:agent"]) {
    assert.throws(() => publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: command, Path: "C:\\Bin" }, "win32"), /depends on the target working directory/);
  }
  for (const directory of ["/Bin", "\\Bin", "C:Bin"]) {
    assert.throws(() => publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "agent", Path: directory }, "win32"), /depends on the target working directory/);
  }
  assert.deepEqual(publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "C:\\Bin\\agent.exe" }, "win32"), ["C:\\Bin\\agent.exe"]);
  assert.deepEqual(publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "C:/Bin/agent.exe" }, "win32"), ["C:/Bin/agent.exe"]);
  assert.deepEqual(publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "\\\\server\\share\\agent.exe" }, "win32"), ["\\\\server\\share\\agent.exe"]);
  assert.deepEqual(publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "agent", Path: "\\\\server\\share", PathExt: ".EXE" }, "win32"), ["\\\\server\\share\\agent", "\\\\server\\share\\agent.EXE"]);
});

test("public launcher metadata preserves POSIX case sensitivity and candidate order", () => {
  assert.deepEqual(publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "agent", PATH: "/first:/second", Path: "/ignored", PATHEXT: ".EXE" }, "linux"), ["/first/agent", "/second/agent"]);
  assert.deepEqual(publicLauncherCandidates({ needlefish_acp_bin: "agent", PATH: "/first" }, "linux"), []);
  assert.deepEqual(publicLauncherCandidates({ NEEDLEFISH_ACP_BIN: "/absolute/agent" }, "linux"), ["/absolute/agent"]);
});


test("Windows public identity normalizes auth declarations before label screening", () => {
  assert.deepEqual(acpRuntimeIdentity(null, { needlefish_acp_auth_env_vars: "SESSION", session: "abc", needlefish_acp_auth_files: "private-config" }, "abc", "win32"), {
    version: 1, launcherDigest: { status: "unknown" }, harnessVersion: { status: "unknown" },
    authSource: { status: "operator_attested", value: "environment-and-files" },
  });
  assert.deepEqual(acpRuntimeIdentity(null, { needlefish_acp_auth_env_vars: "SESSION", session: "abc" }, "Public 1.0", "win32"), {
    version: 1, launcherDigest: { status: "unknown" }, harnessVersion: { status: "operator_attested", value: "Public 1.0" },
    authSource: { status: "operator_attested", value: "environment" },
  });
});
