import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compare, parseArgs, resumeSlots, writeReport } from "../run";
import { fixtureClassifications, qualifyRuntimeConfiguration, readLane, readManifest, renderSite } from "../gen-site";
import { loadFixtures } from "./fixture-catalog";
import { comparisonEnvironmentError, runnerEnvironmentAttestationError } from "./report-integrity";
import { isPublicAttestationLabel, parsePublicRuntimeIdentity } from "./runtime-identity";
import { score } from "./score";

const privatePaths = ["/root/owned-private-provider", "/private/var/private-route", String.raw`C:\Users\private`, String.raw`\\server\private`, "~/private"];
const publicLabels = ["OpenAI", "Anthropic Claude", "Google Vertex AI", "CLIProxyAPI", "openai/gpt-5.6", "@public/agent", "openai:gpt-5.6", "Agent 1.2.3 (public)"];
const labels = { "--provider": "Public provider", "--route": "public", "--runner-version": "Agent 1.2.3" };

test("public labels reject private paths embedded in prose and keep public model selectors", () => {
  for (const privatePath of privatePaths) {
    for (const prefix of ["Public provider at ", "Public provider (", "Public provider:\n"]) {
      assert.equal(isPublicAttestationLabel(prefix + privatePath, {}), false);
    }
  }
  for (const value of publicLabels) assert.equal(isPublicAttestationLabel(value, {}), true);
});

test("CLI metadata refuses embedded paths with value-free errors before writing invocations", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-public-labels-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, "report.json");
  for (const flag of Object.keys(labels)) {
    for (const privatePath of privatePaths) {
      const argv = Object.entries({ ...labels, [flag]: `Public label at ${privatePath}` }).flatMap(([key, value]) => [key, value]);
      assert.throws(() => writeReport(parseArgs([...argv, "--report", reportPath]), [], []), { message: `${flag} requires a public label, not a private endpoint or path` });
      assert.equal(existsSync(reportPath), false);
    }
  }
  const args = parseArgs([...Object.entries(labels).flatMap(([key, value]) => [key, value]), "--report", reportPath]);
  args.provider = "Public provider at /root/owned-private-provider";
  assert.throws(() => writeReport(args, [], []), { message: "--provider requires a public label, not a private endpoint or path" });
  assert.equal(existsSync(reportPath), false);
  args.provider = "openai/gpt-5.6";
  const report = writeReport(args, [], []);
  assert.equal(report.provider, "openai/gpt-5.6");
  assert.match(report.invocation, /--provider openai\/gpt-5\.6/);
  assert.equal(readFileSync(reportPath, "utf8").includes("/root/owned-private-provider"), false);
});

test("nested public runtime metadata refuses embedded paths without publishing their value", () => {
  for (const privatePath of privatePaths) {
    const identity = parsePublicRuntimeIdentity({ version: 1, launcherDigest: { status: "known", value: `sha256:${"a".repeat(64)}` }, harnessVersion: { status: "operator_attested", value: `Agent at ${privatePath}` }, authSource: { status: "operator_attested", value: "environment" } });
    assert.deepEqual(identity.harnessVersion, { status: "unknown" });
    assert.equal(JSON.stringify(identity).includes(privatePath), false);
    assert.equal(comparisonEnvironmentError({ runner: "acp", runnerEnvironment: JSON.stringify([["ACP_PUBLIC_RUNTIME", JSON.stringify(identity)]]) }), "unknown runner environment identity");
  }
});

const manifest = readManifest();
const config = manifest.lanes.find((entry) => entry.status === "Deployed");
assert.ok(config);
const lane = readLane(config);
const catalog = await loadFixtures(null);
const fixtureIds = new Set(lane.report.fixtures);
const historicalCanonical = { ...fixtureClassifications(catalog.filter((fixture) => fixtureIds.has(fixture.id))), promptHash: lane.report.promptHash };

test("public readers refuse embedded private labels before qualification and site rendering", () => {
  assert.equal(qualifyRuntimeConfiguration(lane.report, lane, historicalCanonical).matchStatus, "tested");
  for (const field of ["provider", "route", "runnerVersion"] as const) {
    for (const privatePath of privatePaths) {
      const report = { ...lane.report, [field]: `Public label at ${privatePath}` };
      const unsafeLane = { ...lane, report };
      assert.equal(comparisonEnvironmentError(report), "private runner environment identity");
      assert.equal(runnerEnvironmentAttestationError(report), "public lanes require public provider, route, and runner version labels");
      assert.deepEqual(qualifyRuntimeConfiguration(report, unsafeLane, historicalCanonical), { matchStatus: "unqualified", reason: "report_not_admitted" });
      assert.throws(() => renderSite({ ...manifest, lanes: [config], baseline: config.report }, [unsafeLane], historicalCanonical), /public lanes require public provider, route, and runner version labels/);
    }
  }
});

test("comparison and resume cannot reuse a report carrying embedded private metadata", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-private-label-reader-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "report.json");
  const spec = { id: "public-label-negative", kind: "negative" as const, defectClass: "clean", description: "public label reader", baseFiles: { "src/value.ts": "export const value = 1;" }, headFiles: { "src/value.ts": "export const value = 2;" }, expected: { verdict: "pass" as const } };
  const args = parseArgs([...Object.entries(labels).flatMap(([key, value]) => [key, value]), "--model", "public-model", "--effort", "high", "--report", target]);
  const draw = { fixtureId: spec.id, draw: 0, score: score({ verdict: "pass", findings: [] }, spec.expected, spec.id), durationMs: 1, calls: 1, retries: 0 };
  const report = { ...writeReport(args, [draw], [spec]), anticheatVersion: 2 };
  writeFileSync(target, JSON.stringify(report));
  args.resume = target;
  assert.equal(resumeSlots(args, [spec], [{ spec, draw: 0 }]).skipped, 1);
  const unsafe = { ...report, provider: "Public provider at /root/owned-private-provider" };
  writeFileSync(target, JSON.stringify(unsafe));
  assert.throws(() => compare(target, report), { message: "baseline report has private runner environment identity; cross-report comparison is unavailable." });
  args.resume = target;
  args.provider = unsafe.provider;
  assert.equal(resumeSlots(args, [spec], [{ spec, draw: 0 }]).skipped, 0);
});
