import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acpRuntimeIdentity, matchRuntimeIdentity, parsePublicRuntimeIdentity } from "./runtime-identity";
import { matchQualifiedConfiguration } from "./runtime-qualification";
import { runnerEnvironmentAttestationError } from "./report-integrity";
import { parseArgs, runnerEnvironment, writeReport } from "../run";

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
  for (const value of [url.href, "/Users/private/provider", "/home/private/provider"]) {
    assert.throws(() => parseArgs(["--provider", value, "--route", "public", "--runner-version", "Agent 1.2.3"]), { message: "--provider requires a public label, not a private endpoint or path" });
  }
});
