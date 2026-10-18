import assert from "node:assert/strict";
import childProcess, { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { parseArgs, runnerEnvironment, writeReport } from "./run";
import { createQualificationProof } from "./qualify-release";
import { fixtureClassifications, parseLane, validateManifest, validateComparability, type LaneConfig } from "./gen-site";
import { drawFindings, matchEvidence, score } from "./shared/score";
import type { DrawResult, FixtureSpec } from "./shared/types";
import { review } from "../src/core/review";
import { commitAll, headSha, initRepo, isolateCodexTestHome } from "../src/shared/codex-runner-test-fixtures";
import { parseReviewResult } from "../src/shared/review-result";
import { parseQualificationProof } from "../src/shared/qualification-proof";
import { completeReviewRuntime, parseReviewRuntime, prepareReviewRuntime, reviewRuntime } from "../src/shared/runtime";
import { resolveRunnerConfig } from "../src/shared/codex";
import { isPublicAttestationLabel } from "../src/shared/public-runtime-identity";
import { renderMarkdown } from "../src/shared/render";
import { serializeReviewResult, type Bundle, type Finding } from "../src/shared/schema";

const specs: FixtureSpec[] = Array.from({ length: 9 }, (_, i) => ({ id: `native-control-${i}`, kind: "positive", tier: i < 7 ? 1 : i === 7 ? 2 : 3, defectClass: "control", description: "Synthetic qualification wiring control", baseFiles: { "app.ts": "export const value = 1;\n" }, headFiles: { "app.ts": "export const value = 2;\n" }, expected: { verdict: "changes_requested", anchorFile: "app.ts", mustFind: [{ pattern: "control defect", file: "app.ts" }] } }));
specs.push({ id: "native-negative", kind: "negative", defectClass: "control", description: "Clean wiring control", baseFiles: {}, headFiles: { "app.ts": "export const value = 1;\n" }, expected: { verdict: "pass", noBlockingFindings: true } });
const finding: Finding = { severity: "P2", category: "bug", file: "app.ts", lineStart: 1, lineEnd: 1, title: "control defect", whyItBreaks: "control defect", confidence: 1, suggestedFix: "Fix control", validation: "Control" };
const draws: DrawResult[] = specs.flatMap(spec => Array.from({ length: 3 }, (_, draw) => {
  const findings = spec.kind === "positive" ? [finding] : [];
  return { fixtureId: spec.id, draw, calls: 2, retries: 0, durationMs: 1, findings: drawFindings(findings), matchEvidence: matchEvidence(findings, spec.expected), score: score({ verdict: spec.expected.verdict, findings }, spec.expected, spec.id, undefined, "synthetic-canary", undefined, [{ surface: "final_finding", passKind: "critic", passIndex: 0, promptAttempt: 1, runnerAttempt: 1, outcome: "parsed", finding, content: JSON.stringify(findings) }]) };
}));

function compile(file: string, capture: string, version = "1.2.3", failProbe = false, versionDelayMs = 0): void {
  const source = `${file}.c`;
  const answer = JSON.stringify({ summary: "ok", findings: [], checked: ["source checked"], residual_risks: [] });
  const event = `${JSON.stringify({ type: "item.completed", item: { id: "answer", type: "agent_message", text: answer } })}\n`;
  const criticEvent = `${JSON.stringify({ type: "item.completed", item: { id: "answer", type: "agent_message", text: JSON.stringify({ summary: "ok", decisions: [], checked: ["source checked"], residual_risks: [] }) } })}\n`;
  writeFileSync(source, `#include <stdio.h>\n#include <string.h>\n#include <stdlib.h>\n#include <unistd.h>\n#include <signal.h>\nint main(int argc,char **argv){if(argc==2 && !strcmp(argv[1],"--version")){FILE *v=fopen(${JSON.stringify(capture)},"a");fprintf(v,"VERSION_PROBE=${version}\\nVERSION_PID=%ld\\n",(long)getpid());fclose(v);signal(SIGTERM,SIG_IGN);usleep(${versionDelayMs}*1000);puts("codex-cli ${version}");return ${failProbe ? 1 : 0};}FILE *f=fopen(${JSON.stringify(capture)},"a");fprintf(f,"EXECUTABLE_VERSION=${version}\\n");int c;char *prompt=NULL;size_t promptSize=0;FILE *promptStream=open_memstream(&prompt,&promptSize);while((c=getchar())!=EOF){fputc(c,f);fputc(c,promptStream);}fclose(promptStream);int critic=strstr(prompt,"adversarial critic")!=NULL;free(prompt);fputs("\\nCALL_END\\n",f);for(int i=1;i<argc;i++)fprintf(f,"ARGV=%s\\n",argv[i]);fprintf(f,"HOME=%s\\n",getenv("HOME"));fprintf(f,"PASSTHROUGH=%s\\n",getenv("NF_PRIVATE_SENTINEL")?getenv("NF_PRIVATE_SENTINEL"):"absent");char authpath[4096];if(getenv("CODEX_HOME"))snprintf(authpath,sizeof(authpath),"%s/auth.json",getenv("CODEX_HOME"));else snprintf(authpath,sizeof(authpath),"%s/.codex/auth.json",getenv("HOME"));FILE *a=fopen(authpath,"r");if(a){fputs("AUTH=",f);while((c=fgetc(a))!=EOF)fputc(c,f);fputc('\\n',f);fclose(a);}fclose(f);fputs(critic?${JSON.stringify(criticEvent)}:${JSON.stringify(event)},stdout);return 0;}\n`);
  const built = spawnSync("cc", [source, "-o", file], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
}

test("real report writer and admission proof reach actual CLI/core with exact, different and unknown identities", async t => {
  if (process.platform === "win32") { t.skip("native fixture compiler is Unix-only"); return; }
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-native-"));
  const releaseFile = new URL("../release.json", import.meta.url);
  const originalRelease = existsSync(releaseFile) ? readFileSync(releaseFile) : undefined;
  const previous = { ...process.env };
  isolateCodexTestHome(t, tmp);
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    Object.assign(process.env, previous);
    if (originalRelease) writeFileSync(releaseFile, originalRelease); else rmSync(releaseFile, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  });
  for (const key of Object.keys(process.env)) if (/^(CODEX_|NEEDLEFISH_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|http_proxy$|https_proxy$|no_proxy$)/.test(key) && key !== "NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS") delete process.env[key];
  const home = path.join(tmp, "source-home");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), '{"synthetic":"initial-auth-sentinel"}');
  const publicArtifacts = mkdtempSync(path.resolve("eval/.native-control-"));
  t.after(() => rmSync(publicArtifacts, { recursive: true, force: true }));
  const bin = path.join(publicArtifacts, "codex");
  const capture = path.join(tmp, "stdin.txt");
  compile(bin, capture);
  Object.assign(process.env, { CODEX_BIN: bin, HOME: home, NEEDLEFISH_EPHEMERAL_HOME: "1", NEEDLEFISH_EVAL_TRACE: "1", NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_NO_RETRY: "1", CODEX_REASONING_EFFORT: "high" });
  const reportFile = path.join(tmp, "native-control.json");
  const args = parseArgs(["--runner", "codex", "--model", "public-model", "--effort", "high", "--draws", "3", "--provider", "OpenAI Codex", "--route", "Codex native", "--runner-version", "1.2.3", "--public-launcher-artifact", bin, "--report", reportFile]);
  const nativeBytes = readFileSync(bin);
  const nativeDigest = `sha256:${createHash("sha256").update(nativeBytes).digest("hex")}`;
  const emitted = writeReport(args, draws, specs);
  assert.equal(emitted.privateEnvironment, false);
  const bytes = readFileSync(reportFile, "utf8");
  assert.deepEqual(JSON.parse(bytes), emitted);
  const reportEnvironment: unknown = JSON.parse(emitted.runnerEnvironment);
  assert.ok(Array.isArray(reportEnvironment));
  assert.deepEqual(reportEnvironment.filter(entry => Array.isArray(entry) && ["CODEX_BIN", "CODEX_PUBLIC_NATIVE"].includes(entry[0])), [["CODEX_BIN", nativeDigest], ["CODEX_PUBLIC_NATIVE", nativeDigest]]);
  const lane: LaneConfig = { report: "results/native-control.json", name: "Native control", runner: "codex", model: "public-model", effort: "high", status: "Candidate" };
  assert.ok(emitted.gitSha);
  validateManifest({ updated: emitted.createdAt.slice(0,10), baseline: lane.report, lanes: [lane], blocked: [] });
  validateComparability([parseLane(lane, bytes)], lane.report, fixtureClassifications(specs));
  assert.equal(emitted.reproductionCommand.includes("<redacted>"), false);
  assert.ok(emitted.reproductionCommand.includes(path.relative(process.cwd(), bin)));
  const externalBin = path.join(tmp, "external-codex");
  copyFileSync(bin, externalBin);
  process.env.CODEX_BIN = externalBin;
  const externalArgs = { ...args, publicLauncherArtifact: externalBin, report: path.join(tmp, "native-external.json") };
  const external = writeReport(externalArgs, draws, specs);
  assert.equal(external.reproductionCommand.includes("'<redacted>'"), true);
  assert.equal(JSON.stringify(external).includes(externalBin), false);
  const sourceSha = emitted.gitSha;
  const externalBytes = readFileSync(externalArgs.report, "utf8");
  const externalLane = { ...lane, report: "results/native-external.json" };
  assert.throws(() => validateComparability([parseLane(externalLane, externalBytes)], externalLane.report, fixtureClassifications(specs)), /reproduction command cannot contain private or required placeholders/);
  assert.throws(() => createQualificationProof(externalBytes, externalLane, fixtureClassifications(specs), sourceSha), /refused/);
  process.env.CODEX_BIN = bin;
  const proof = createQualificationProof(bytes, lane, fixtureClassifications(specs), emitted.gitSha);
  assert.equal(proof.identity.runnerEnvironment, emitted.runnerEnvironment);
  assert.equal(proof.reportSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.throws(() => createQualificationProof(bytes, lane, fixtureClassifications(specs), "f".repeat(40)), /exact release/);
  assert.throws(() => createQualificationProof(bytes, lane, { ...fixtureClassifications(specs), fixtureSetHash: "stale" }, emitted.gitSha!), /refused/);
  assert.throws(() => parseQualificationProof({ ...proof, reportSha256: "bad" }), /proof/);
  assert.throws(() => parseQualificationProof({ ...proof, reportId: "results/../private.json" }), /proof/);
  writeFileSync(releaseFile, JSON.stringify({ sha: emitted.gitSha, qualification: proof }));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "app.ts"), "export const value = 1;\n");
  commitAll(repo, "source");
  const bundle: Bundle = { repoPath: repo, baseSha: headSha(repo), headSha: headSha(repo), patch: "short", patchStat: "app.ts | 1 +", changedFiles: [{ path: "app.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null };
  const run = () => review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 });
  const nativeProbes: { status: number | null; signal: NodeJS.Signals | null; expectedVersion: boolean; errorCode?: unknown; stdinErrorCode?: unknown }[] = [];
  const spawn = childProcess.spawn;
  const observedSpawn = t.mock.method(childProcess, "spawn", (...args: Parameters<typeof childProcess.spawn>) => {
    const child = spawn(...args);
    if (args[0] === bin && args[1]?.length === 1 && args[1][0] === "--version") {
      const observation: (typeof nativeProbes)[number] = { status: null, signal: null, expectedVersion: false };
      nativeProbes.push(observation);
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on("error", error => { observation.errorCode = "code" in error ? error.code : "unknown"; });
      child.stdin?.on("error", error => { observation.stdinErrorCode = "code" in error ? error.code : "unknown"; });
      child.on("close", (status, signal) => { observation.status = status; observation.signal = signal; observation.expectedVersion = stdout.trim() === "codex-cli 1.2.3"; });
    }
    return child;
  });
  syncBuiltinESMExports();
  const exact = await run().finally(() => { observedSpawn.mock.restore(); syncBuiltinESMExports(); });
  if (exact.runtime?.qualification.matchStatus !== "tested") {
    const versionProbes = (readFileSync(capture, "utf8").match(/VERSION_PROBE/g) ?? []).length;
    const probe = spawnSync(bin, ["--version"], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tmp, USERPROFILE: tmp }, timeout: 2000 });
    t.diagnostic(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, fixture: bin,
      fixtureDigest: `sha256:${createHash("sha256").update(readFileSync(bin)).digest("hex")}`,
      reportEnvironment: emitted.runnerEnvironment, proofIdentity: proof.identity, runtime: exact.runtime,
      reviewCalls: (readFileSync(capture, "utf8").match(/CALL_END/g) ?? []).length,
      versionProbes,
      versionLabelPublic: isPublicAttestationLabel("codex-cli 1.2.3", process.env), nativeProbes, diagnosticProbe: { status: probe.status, signal: probe.signal, errorCode: probe.error && "code" in probe.error ? probe.error.code : undefined, expectedVersion: probe.stdout?.trim() === "codex-cli 1.2.3" } }));
  }
  assert.deepEqual(exact.runtime?.qualification, { matchStatus: "tested", policyVersion: proof.policyVersion, reportId: lane.report });
  assert.deepEqual(nativeProbes, [{ status: 0, signal: null, expectedVersion: true }]);
  assert.deepEqual(exact.runtime?.launcherDigest, { status: "known", value: nativeDigest });
  assert.equal(exact.verdict, "pass");
  const inheritedEffort = await review(bundle, { runner: "codex", model: "public-model", timeoutMs: 10000 });
  assert.deepEqual(inheritedEffort.runtime?.qualification, { matchStatus: "tested", policyVersion: proof.policyVersion, reportId: lane.report });
  assert.deepEqual(exact.findings, []);
  assert.deepEqual(parseReviewResult(JSON.parse(serializeReviewResult(exact))), exact);
  const schema: unknown = JSON.parse(readFileSync(new URL("../schemas/review-result.v1.schema.json", import.meta.url), "utf8"));
  assert.ok(typeof schema === "object" && schema !== null && !Array.isArray(schema));
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(JSON.parse(serializeReviewResult(exact))), true, JSON.stringify(validate.errors));
  assert.match(renderMarkdown(exact), /Configuration matches an evaluated version/);
  writeFileSync(path.join(repo, "app.ts"), "export const value = 2;\n");
  const cli = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "--repo", repo, "--base", "HEAD", "--uncommitted", "--runner", "codex", "--model", "public-model", "--json"], { cwd: path.resolve(new URL("../", import.meta.url).pathname), encoding: "utf8", env: process.env });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(parseReviewResult(JSON.parse(cli.stdout)).runtime?.qualification.matchStatus, "tested");
  const stdin = readFileSync(capture, "utf8");
  assert.match(stdin, /ARGV=--ignore-user-config/);
  assert.match(stdin, /ARGV=--ignore-rules/);
  assert.match(stdin, /ARGV=model_reasoning_effort="high"/);
  assert.match(stdin, /ARGV=-m\nARGV=public-model/);
  assert.match(stdin, /AUTH=\{"synthetic":"initial-auth-sentinel"\}/);
  assert.equal(stdin.includes('"runtime"'), false);
  assert.equal(stdin.includes("qualification"), false);
  assert.equal(stdin.includes("launcherDigest"), false);
  assert.equal(JSON.stringify(exact.runtime).includes("initial-auth-sentinel"), false);
  const evidenceDirectory = previous.NEEDLEFISH_TEST_ARTIFACT_DIR;
  if (evidenceDirectory) {
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(evidenceDirectory, "actual-stdin-argv-auth.txt"), stdin);
    writeFileSync(path.join(evidenceDirectory, "bundle.json"), JSON.stringify(bundle, null, 2));
    writeFileSync(path.join(evidenceDirectory, "actual-result.json"), serializeReviewResult(exact));
    writeFileSync(path.join(evidenceDirectory, "generated-proof.json"), JSON.stringify(proof, null, 2));
    writeFileSync(path.join(evidenceDirectory, "emitted-report.json"), bytes);
    writeFileSync(path.join(evidenceDirectory, "actual-cli-result.json"), cli.stdout);
  }
  const customHome = path.join(tmp, "custom-codex-home");
  mkdirSync(customHome);
  writeFileSync(path.join(customHome, "auth.json"), '{"synthetic":"custom-auth-control"}');
  writeFileSync(path.join(customHome, "config.toml"), 'model = "initial-config-control"');
  rmSync(path.join(home, ".codex", "auth.json"));
  Object.assign(process.env, { CODEX_HOME: customHome, NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "CODEX_HOME" });
  writeFileSync(capture, "");
  let customChanged = false;
  const custom = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 }, undefined, () => {
    if (!customChanged && readFileSync(capture, "utf8").includes("CALL_END")) {
      customChanged = true;
      writeFileSync(path.join(customHome, "auth.json"), '{"synthetic":"replacement-custom-auth"}');
      writeFileSync(path.join(customHome, "config.toml"), 'model = "replacement-config-control"');
      process.env.CODEX_HOME = path.join(tmp, "missing-custom-home");
    }
  });
  assert.equal(custom.verdict, "pass");
  assert.deepEqual(custom.runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  const customCalls = readFileSync(capture, "utf8");
  assert.equal((customCalls.match(/AUTH=\{"synthetic":"custom-auth-control"\}/g) ?? []).length, 2);
  assert.equal(customCalls.includes("replacement-custom-auth"), false);
  assert.equal(JSON.stringify(custom.runtime).includes(customHome), false);
  process.env.CODEX_HOME = customHome;
  const customArgs = { ...args, report: path.join(tmp, "private-custom.json") };
  const customReport = writeReport(customArgs, draws, specs);
  assert.equal(customReport.privateEnvironment, true);
  assert.equal(customReport.runnerEnvironment.includes(customHome), false);
  assert.throws(() => createQualificationProof(readFileSync(customArgs.report, "utf8"), lane, fixtureClassifications(specs), emitted.gitSha!), /refused/);
  customArgs.environmentIdentity = customReport.runnerEnvironment;
  writeFileSync(path.join(customHome, "config.toml"), 'model = "drifted-config-control"');
  assert.throws(() => runnerEnvironment(customArgs), /environment changed during the eval run/);
  delete process.env.CODEX_HOME;
  delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
  writeFileSync(path.join(home, ".codex", "auth.json"), '{"synthetic":"initial-auth-sentinel"}');
  assert.equal((await run()).runtime?.qualification.matchStatus, "tested");
  writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "standard-config-control"');
  writeFileSync(capture, "");
  let configChanged = false;
  const configDrift = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 }, undefined, () => {
    if (!configChanged && readFileSync(capture, "utf8").includes("CALL_END")) {
      configChanged = true;
      writeFileSync(path.join(home, ".codex", "config.toml"), 'model = "changed-standard-config"');
    }
  });
  assert.equal(configDrift.verdict, "pass");
  assert.deepEqual(configDrift.runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  rmSync(path.join(home, ".codex", "config.toml"));
  assert.equal((await run()).runtime?.qualification.matchStatus, "tested");
  process.env.CODEX_HOME = path.join(tmp, "unused-ambient-home");
  let unusedHomeChanged = false;
  const unusedHome = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 }, undefined, () => {
    if (!unusedHomeChanged) { unusedHomeChanged = true; process.env.CODEX_HOME = path.join(tmp, "unused-replacement-home"); }
  });
  assert.deepEqual(unusedHome.runtime?.qualification, { matchStatus: "tested", policyVersion: proof.policyVersion, reportId: lane.report });
  delete process.env.CODEX_HOME;
  const privateSelectorArgs = { ...args, model: null, report: path.join(tmp, "private-selector.json") };
  process.env.CODEX_API_KEY = "synthetic-selector-secret";
  for (const selector of ["https://example.invalid/private-model", "synthetic-selector-secret"]) {
    process.env.CODEX_MODEL = selector;
    const privateSelector = writeReport(privateSelectorArgs, draws, specs);
    assert.equal(privateSelector.privateEnvironment, true);
    assert.equal(JSON.stringify(privateSelector).includes(selector), false);
    assert.equal(privateSelector.runnerEnvironment.includes('["CODEX_MODEL","<required>"]'), true);
  }
  delete process.env.CODEX_MODEL;
  delete process.env.CODEX_API_KEY;
  const fullArgs = { ...args, runnerVersion: "codex-cli 1.2.3", report: path.join(tmp, "native-full.json") };
  writeReport(fullArgs, draws, specs);
  const fullProof = createQualificationProof(readFileSync(fullArgs.report, "utf8"), { ...lane, report: "results/native-full.json" }, fixtureClassifications(specs), emitted.gitSha);
  writeFileSync(releaseFile, JSON.stringify({ sha: emitted.gitSha, qualification: fullProof }));
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "unqualified", reason: "different_configuration" });
  writeFileSync(releaseFile, JSON.stringify({ sha: emitted.gitSha, qualification: proof }));
  compile(bin, path.join(tmp, "same-version-capture.txt"));
  const replacementDigest = `sha256:${createHash("sha256").update(readFileSync(bin)).digest("hex")}`;
  assert.notEqual(replacementDigest, nativeDigest);
  const sameVersionReplacement = await run();
  assert.deepEqual(sameVersionReplacement.runtime?.runnerVersion, { status: "known", value: "1.2.3" });
  assert.deepEqual(sameVersionReplacement.runtime?.qualification, { matchStatus: "unqualified", reason: "different_configuration" });
  if (evidenceDirectory) writeFileSync(path.join(evidenceDirectory, "same-version-replacement.json"), JSON.stringify({ nativeDigest, replacementDigest, result: sameVersionReplacement }, null, 2));
  writeFileSync(bin, nativeBytes);
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "tested", policyVersion: proof.policyVersion, reportId: lane.report });
  compile(bin, capture, "2.0.0");
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "unqualified", reason: "different_configuration" });
  compile(bin, capture, "1.2.3", true);
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  const finiteBudget = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000, reviewBudgetMs: 3000 });
  assert.equal(finiteBudget.verdict, "pass");
  assert.deepEqual(finiteBudget.runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  compile(bin, capture);
  let changed = false;
  const drift = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 }, undefined, () => {
    if (!changed && existsSync(capture)) { changed = true; writeFileSync(path.join(home, ".codex", "auth.json"), '{"synthetic":"changed-auth-sentinel"}'); process.env.CODEX_BIN = "/missing-next-runner"; }
  });
  assert.equal(drift.verdict, "pass");
  args.environmentIdentity = emitted.runnerEnvironment;
  assert.throws(() => runnerEnvironment(args), /environment changed during the eval run/);
  assert.deepEqual(drift.runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "NF_PRIVATE_SENTINEL";
  process.env.NF_PRIVATE_SENTINEL = "initial-private-control";
  writeFileSync(capture, "");
  let environmentChanged = false;
  const envDrift = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 }, undefined, () => {
    if (!environmentChanged && readFileSync(capture, "utf8").includes("CALL_END")) { environmentChanged = true; process.env.NF_PRIVATE_SENTINEL = "replacement-private-control"; process.env.CODEX_BIN = "/missing-next-runner"; }
  });
  const frozenEnvironment = readFileSync(capture, "utf8");
  assert.equal(envDrift.verdict, "pass");
  assert.equal((frozenEnvironment.match(/PASSTHROUGH=initial-private-control/g) ?? []).length, 2);
  assert.equal(frozenEnvironment.includes("replacement-private-control"), false);
  assert.equal(JSON.stringify(envDrift.runtime).includes("initial-private-control"), false);
  assert.equal(envDrift.runtime?.qualification.matchStatus, "unqualified");
  process.env.CODEX_BIN = bin;
  delete process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH;
  delete process.env.NF_PRIVATE_SENTINEL;
  const next = path.join(tmp, "next");
  compile(next, capture, "3.0.0");
  writeFileSync(capture, "");
  let replaced = false;
  await assert.rejects(review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 }, undefined, () => { if (!replaced && readFileSync(capture, "utf8").includes("CALL_END")) { replaced = true; copyFileSync(next, bin); } }), /captured Codex executable changed/);
  const mutatedCalls = readFileSync(capture, "utf8");
  assert.equal((mutatedCalls.match(/EXECUTABLE_VERSION=1.2.3/g) ?? []).length, 1);
  assert.equal((mutatedCalls.match(/EXECUTABLE_VERSION=3.0.0/g) ?? []).length, 0);
  writeFileSync(bin, `#!/bin/sh\nif [ "$1" = --version ]; then echo codex-cli 1.2.3; exit 0; fi\nexec ${JSON.stringify(next)} "$@"\n`);
  chmodSync(bin, 0o755);
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  compile(bin, capture);
  const privateEndpoint = new URL("https://example.invalid/path");
  privateEndpoint.username = "user";
  privateEndpoint.password = "synthetic-password";
  privateEndpoint.searchParams.set("token", "synthetic-query");
  process.env.CODEX_PROXY_BASE_URL = privateEndpoint.href;
  process.env.CODEX_PROXY_API_KEY = "synthetic-proxy-credential";
  const privateRoute = await run();
  assert.equal(privateRoute.verdict, "pass");
  assert.deepEqual(privateRoute.runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  assert.equal(JSON.stringify(privateRoute.runtime).includes("synthetic-password"), false);
  assert.equal(JSON.stringify(privateRoute.runtime).includes("synthetic-proxy-credential"), false);
  delete process.env.CODEX_PROXY_BASE_URL;
  delete process.env.CODEX_PROXY_API_KEY;
  delete process.env.NEEDLEFISH_EVAL_TRACE;
  const noGuard = await run();
  assert.equal(noGuard.runtime?.qualification.matchStatus, "unqualified");
  assert.equal(noGuard.candidateFindings, undefined);
  assert.equal(process.env.NEEDLEFISH_EVAL_TRACE, undefined);
  process.env.NEEDLEFISH_EVAL_TRACE = "1";
  writeFileSync(releaseFile, JSON.stringify({ base_sha: emitted.gitSha, qualification: proof }));
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  writeFileSync(releaseFile, JSON.stringify({ sha: emitted.gitSha, qualification: { ...proof, reportSha256: "bad" } }));
  assert.deepEqual((await run()).runtime?.qualification, { matchStatus: "unqualified", reason: "report_not_admitted" });
  writeFileSync(releaseFile, JSON.stringify({ sha: emitted.gitSha, qualification: proof }));
  compile(bin, capture, "1.2.3", false, 5000);
  writeFileSync(capture, "");
  const started = performance.now();
  const bounded = await review(bundle, { runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000, reviewBudgetMs: 1500 });
  const elapsed = performance.now() - started;
  assert.equal(bounded.verdict, "pass");
  assert.deepEqual(bounded.findings, exact.findings);
  assert.deepEqual(bounded.checked, ["source checked"]);
  assert.deepEqual(bounded.runtime?.qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  assert.equal((readFileSync(capture, "utf8").match(/CALL_END/g) ?? []).length, 2);
  assert.equal((readFileSync(capture, "utf8").match(/VERSION_PROBE/g) ?? []).length, 1);
  const heldProbe = /VERSION_PID=(\d+)/.exec(readFileSync(capture, "utf8"));
  assert.ok(heldProbe);
  assert.throws(() => process.kill(Number(heldProbe[1]), 0), { code: "ESRCH" });
  assert.ok(elapsed < 1900, `metadata probe exceeded the shared review budget (${elapsed}ms)`);
  writeFileSync(capture, "");
  const expiredConfig = resolveRunnerConfig({ runner: "codex", model: "public-model", reasoningEffort: "high", timeoutMs: 10000 });
  prepareReviewRuntime(expiredConfig);
  await completeReviewRuntime(expiredConfig, tmp, performance.now() - 1);
  assert.deepEqual(reviewRuntime(expiredConfig, 1).qualification, { matchStatus: "unqualified", reason: "unknown_identity" });
  assert.equal(readFileSync(capture, "utf8"), "");
  const legacy = { ...exact }; delete legacy.runtime;
  assert.deepEqual(parseReviewResult(JSON.parse(serializeReviewResult(legacy))), legacy);
  assert.throws(() => parseReviewRuntime({ ...exact.runtime, runnerVersion: { status: "unknown" } }), /complete public/);
  assert.throws(() => parseReviewRuntime({ ...exact.runtime, qualification: { matchStatus: "tested", reportId: lane.report, policyVersion: "wrong" } }), /qualification/);
});

for (const windows of [false, true]) {
  test(`native report environment follows platform casing windows=${windows}`, t => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-report-casing-"));
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const previous = { ...process.env };
    isolateCodexTestHome(t, tmp);
    assert.ok(platform);
    t.after(() => {
      Object.defineProperty(process, "platform", platform);
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
      rmSync(tmp, { recursive: true, force: true });
    });
    for (const key of Object.keys(process.env)) if (/^(CODEX_|NEEDLEFISH_|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$|http_proxy$|https_proxy$|no_proxy$|PATH$|Path$)/.test(key)) delete process.env[key];
    const binary = path.join(tmp, "codex.exe");
    writeFileSync(binary, "MZsynthetic-report-casing"); chmodSync(binary, 0o755);
    Object.assign(process.env, { HOME: tmp, USERPROFILE: tmp, Codex_Bin: binary, Path: tmp, NEEDLEFISH_EPHEMERAL_HOME: "1", NEEDLEFISH_EVAL_TRACE: "1" });
    const args = parseArgs(["--runner", "codex", "--model", "public-model", "--effort", "high", "--public-launcher-artifact", binary]);
    Object.defineProperty(process, "platform", { ...platform, value: windows ? "win32" : "darwin" });
    if (windows) {
      const pairs: unknown = JSON.parse(runnerEnvironment(args));
      assert.ok(Array.isArray(pairs));
      assert.deepEqual(pairs.find(entry => Array.isArray(entry) && entry[0] === "CODEX_BIN"), ["CODEX_BIN", `sha256:${createHash("sha256").update("MZsynthetic-report-casing").digest("hex")}`]);
      assert.deepEqual(pairs.find(entry => Array.isArray(entry) && entry[0] === "PATH"), ["PATH", `sha256:${createHash("sha256").update(tmp).digest("hex").slice(0,16)}`]);
    } else assert.throws(() => runnerEnvironment(args), /configured readable/);
  });
}
