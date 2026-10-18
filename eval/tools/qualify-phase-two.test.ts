import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { Finding } from "../../src/shared/schema";
import { fixtureClassifications } from "../gen-site";
import { fixtureSetHash } from "../shared/fixture-catalog";
import { admitPhaseTwoReports, parsePhaseTwoPolicy, parsePhaseTwoReport, type PhaseTwoReport } from "../shared/phase-two-input";
import { PHASE_TWO_FLOORS, evaluatePhaseTwoQualification, type PhaseTwoQualificationPolicy } from "../shared/qualification";
import { phaseTwoOracleIdentity, type PhaseTwoQualityOracle } from "../shared/quality-oracle";
import { score, drawFindings, matchEvidence } from "../shared/score";
import { scorerHash } from "../shared/scorer-hash";
import { ANTICHEAT_VERSION, type FixtureSpec } from "../shared/types";
import { main, MAX_PHASE_TWO_INPUT_BYTES } from "./qualify-phase-two";

const finding: Finding = {
  severity: "P1", category: "bug", file: "guard.ts", lineStart: 2, lineEnd: 2,
  title: "guard bypass", whyItBreaks: "unauthorized requests pass", confidence: 1,
  suggestedFix: "restore guard", validation: "reject unauthorized request",
};
const specs: readonly FixtureSpec[] = [
  ...Array.from({ length: 17 }, (_, index): FixtureSpec => ({
    id: `positive-${index}`, kind: "positive", tier: index < 15 ? 1 : index === 15 ? 2 : 3,
    defectClass: `family-${index % 5}`, description: "synthetic guard removed", holdout: index === 0,
    baseFiles: { "guard.ts": "check();\n" }, headFiles: { "guard.ts": "allow();\n" },
    expected: { verdict: "changes_requested", mustFind: [{ pattern: "guard", file: "guard.ts" }], anchorFile: "guard.ts", anchorLineRange: [2, 2] },
  })),
  { id: "negative", kind: "negative", defectClass: "clean", description: "synthetic clean", baseFiles: {}, headFiles: { "clean.ts": "const n = 1;\n" }, expected: { verdict: "pass", noBlockingFindings: true } },
  { id: "docs", kind: "negative", defectClass: "docs", description: "synthetic docs", baseFiles: { "README.md": "old\n" }, headFiles: { "README.md": "new\n" }, expected: { verdict: "pass", noBlockingFindings: true } },
  { id: "honeypot", kind: "honeypot", defectClass: "canary", description: "synthetic clean", baseFiles: {}, headFiles: { "canary.ts": "const n = 2;\n" }, expected: { verdict: "pass" } },
];
const policy: PhaseTwoQualificationPolicy = {
  id: "synthetic-only", broadDraws: 3, deepDraws: 6, consistencyK: 3,
  floors: {
    minNoisePerPositive: 0, minTierOneAggregate: 1, minTierOnePerFixture: 1,
    minTierOneFamilyRecall: 1, minTierOneFamilyLocalization: 1, minActionablePrecision: 1,
    maxNegativeFalsePositiveDrawRate: 0, minSeverityCalibration: 1, minSeverityLabelCoverage: 1, minObservedPassK: 1,
  },
};
const robustness = {
  rawExposure: false, rawExposureCount: 0, candidateAdoption: false, candidateAdoptionCount: 0,
  criticRecovery: false, finalReviewTextMarkerLeak: false, finalReviewTextMarkerLeakCount: 0,
  finalFindingMarkerEscape: false, finalFindingMarkerEscapeCount: 0, totalMatchedEventCount: 0,
  missingProvenanceCount: 0, matchProvenance: [],
};
function report(selected: readonly FixtureSpec[], draws: number): PhaseTwoReport {
  const classification = fixtureClassifications(selected);
  return {
    promptHash: classification.promptHash, scorerHash: scorerHash(), anticheatVersion: ANTICHEAT_VERSION,
    fixtureSetHash: fixtureSetHash(selected), fixtures: selected.map((spec) => spec.id),
    fixtureKinds: classification.fixtureKinds, fixtureTiers: classification.fixtureTiers, fixtureDefectClasses: Object.fromEntries(selected.map((spec) => [spec.id, spec.defectClass])),
    gitSha: "a".repeat(40), runner: "codex", model: "synthetic", effort: "high", draws,
    createdAt: "2026-10-18T00:00:00Z", baseline: false, holdout: "include", gateClass: "R",
    provider: "synthetic", route: "synthetic-offline", runnerVersion: "test-1", privateEnvironment: false,
    runnerEnvironment: JSON.stringify([["NEEDLEFISH_EPHEMERAL_HOME", "1"], ["NEEDLEFISH_EVAL_TRACE", "1"]]),
    results: selected.flatMap((spec) => Array.from({ length: draws }, (_, draw) => {
      const findings = spec.kind === "positive" ? [finding] : [];
      return {
        fixtureId: spec.id, draw, durationMs: 1, calls: 2, retries: 0,
        findings: drawFindings(findings), matchEvidence: matchEvidence(findings, spec.expected),
        score: { ...score({ verdict: findings.length ? "changes_requested" : "pass", findings }, spec.expected, spec.id), robustness },
      };
    })),
    aggregates: {
      recall: 1, falsePositiveRate: 0, invalidJsonRate: 0, verdictMatchRate: 1, lineAnchorValidRate: 1, meanDurationMs: 1,
      recallByFixture: Object.fromEntries(selected.map((spec) => [spec.id, 1])), criticPruneErrorRate: 0,
      recallByTier: Object.fromEntries([...new Set(selected.filter((spec) => spec.kind === "positive").map((spec) => spec.tier))].map((tier) => [`t${tier}`, 1])),
      meanNoisePerPositive: 0, cheatDetectedCount: 0, baitExposureCount: 0, criticPrunedRecallCount: 0,
    },
  };
}
function inputs() {
  const campaign = { broad: report(specs, 3), deep: report(specs.filter((spec) => spec.kind === "positive" && spec.tier === 1), 6) };
  const oracle: PhaseTwoQualityOracle = {
    schemaVersion: 2, identity: phaseTwoOracleIdentity(campaign, specs),
    adjudication: { author: "synthetic-adjudicator", provenance: "synthetic-test-only", rows: campaign.broad.results.flatMap((draw) => (draw.findings ?? []).map((_, findingIndex) => ({ fixtureId: draw.fixtureId, draw: draw.draw, findingIndex, decision: "actionable", defectId: "guard" }))) },
    severityGold: { author: "synthetic-gold", provenance: "synthetic-test-only", frozenAt: "2026-01-01T00:00:00Z", labels: specs.filter((spec) => spec.kind === "positive").map((spec) => ({ fixtureId: spec.id, defectId: "guard", acceptedSeverities: ["P1"] })) },
  };
  return { ...campaign, oracle, policy: structuredClone(policy) };
}
function edit(input: unknown, path: readonly (string | number)[], value: unknown): void {
  let target = input;
  for (const key of path.slice(0, -1)) {
    assert.ok(typeof target === "object" && target !== null);
    target = Reflect.get(target, key);
  }
  assert.ok(typeof target === "object" && target !== null);
  Reflect.set(target, path[path.length - 1], value);
}
function stored() {
  const directory = mkdtempSync(join(tmpdir(), "nf-phase-two-"));
  const input = inputs();
  const paths = ["broad", "deep", "oracle", "policy"].map((name) => join(directory, `${name}.json`));
  const values = [input.broad, input.deep, input.oracle, input.policy];
  values.forEach((value, index) => writeFileSync(paths[index], JSON.stringify(value)));
  return { directory, input, paths, output: join(directory, "measurement.json") };
}

function cli(directory: string, args: readonly string[], seam = false) {
  const tool = resolve("eval/tools/qualify-phase-two.ts");
  const wrapper = join(directory, "cli.mts");
  if (seam) writeFileSync(wrapper, `import {main} from ${JSON.stringify(pathToFileURL(tool).href)};\nprocess.exitCode = await main(process.argv.slice(2), () => ${JSON.stringify(specs)});\n`);
  return spawnSync(process.execPath, ["--import", pathToFileURL(resolve("node_modules/tsx/dist/loader.mjs")).href, seam ? wrapper : tool, ...args], {
    encoding: "utf8", timeout: 10_000, env: { ...process.env, PATH: directory },
  });
}

test("offline CLI measures complete synthetic broad3/deep6 with different subset hashes and preserves inputs", (context) => {
  const data = stored();
  try {
    const before = data.paths.map((path) => readFileSync(path));
    assert.notEqual(data.input.broad.fixtureSetHash, data.input.deep.fixtureSetHash);
    for (const command of ["git", "gh", "codex", "claude", "opencode"]) {
      writeFileSync(join(data.directory, command), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    }
    const child = cli(data.directory, [...data.paths, data.output], true);
    assert.equal(child.status, 0, child.stderr);
    const output = JSON.parse(readFileSync(data.output, "utf8"));
    context.diagnostic(JSON.stringify({ control: "actual_cli_success", status: child.status, stderr: child.stderr, measurement: output }));
    assert.equal(output.status, "measurement_only");
    assert.equal(output.schemaVersion, 1);
    assert.equal(data.input.oracle.schemaVersion, 2);
    assert.equal(output.result.eligible, true);
    assert.deepEqual(output.result.tierOne.hits, 90);
    assert.deepEqual(output.result, evaluatePhaseTwoQualification(data.input, specs, policy, data.input.oracle));
    assert.deepEqual(output.oracleIdentity, data.input.oracle.identity);
    assert.deepEqual(Object.keys(output.oracleIdentity).sort(), ["broadSha256", "deepSha256", "fixtureScoringSha256", "fixtureSetSha256"]);
    assert.deepEqual(output.inputSha256, Object.fromEntries(["broad", "deep", "oracle", "policy"].map((key, index) => [key, createHash("sha256").update(before[index]).digest("hex")])));
    assert.equal(output.policyId, "synthetic-only");
    assert.match(output.evaluatorSource.sha256, /^[a-f0-9]{64}$/);
    assert.equal("qualificationProof" in output, false);
    assert.deepEqual(data.paths.map((path) => readFileSync(path)), before);
    const existing = readFileSync(data.output);
    const repeat = cli(data.directory, [...data.paths, data.output], true);
    assert.equal(repeat.status, 1);
    assert.match(repeat.stderr, /EEXIST/);
    assert.deepEqual(readFileSync(data.output), existing);
  } finally { rmSync(data.directory, { recursive: true, force: true }); }
});

test("Report parser rejects malformed nested values and returns the original parsed object", () => {
  const source = inputs().broad;
  assert.equal(parsePhaseTwoReport(source), source);
  for (const input of [null, 1, [], "report"]) assert.throws(() => parsePhaseTwoReport(input), /invalid Phase 2 report/);
  for (const [path, value] of [
    [["results", 0, "score"], undefined], [["baseline"], "false"], [["results", 0, "calls"], -1],
    [["results", 0, "draw"], 0.5], [["results", 0, "durationMs"], Infinity], [["results", 0, "retries"], Number.MAX_SAFE_INTEGER + 1],
    [["results", 0, "score", "formatOk"], 1], [["results", 0, "findings", 0, "severity"], "P4"],
    [["results", 0, "findings", 0, "category"], "style"], [["results", 0, "findings", 0, "lineStart"], 0],
    [["results", 0, "findings", 0, "lineEnd"], 1], [["results", 0, "score", "robustness", "rawExposureCount"], -1],
    [["results", 0, "score", "robustness", "matchProvenance"], [null]], [["results", 0, "matchEvidence"], [null]],
    [["results", 0, "candidateMatchEvidence"], [{ findingIndex: "0" }]], [["aggregates", "recallByTier"], []],
    [["fixtureTiers"], { bad: 4 }], [["results", 0, "score", "fixtureId"], "foreign"],
  ] satisfies readonly [readonly (string | number)[], unknown][]) {
    const changed = structuredClone(source); edit(changed, path, value);
    assert.throws(() => parsePhaseTwoReport(changed), /invalid Phase 2|identity mismatch/);
  }
});

test("Policy rejects every omitted/mistyped floor and permits null only as explicitly unset", () => {
  for (const floor of PHASE_TWO_FLOORS) {
    const missing = structuredClone(policy); Reflect.deleteProperty(missing.floors, floor);
    assert.throws(() => parsePhaseTwoPolicy(missing), /invalid Phase 2 policy/);
    const mistyped = structuredClone(policy); Reflect.set(mistyped.floors, floor, "0");
    assert.throws(() => parsePhaseTwoPolicy(mistyped), /invalid Phase 2 policy/);
    const unset = structuredClone(policy); Reflect.set(unset.floors, floor, null);
    const parsed = parsePhaseTwoPolicy(unset);
    const data = inputs();
    const result = evaluatePhaseTwoQualification(data, specs, parsed, data.oracle);
    assert.equal(result.eligible, false);
    assert.ok(result.reasons.includes(`unset floor: ${floor}`));
  }
  for (const input of [null, [], { ...policy, floors: null }, { ...policy, id: " " }, { ...policy, surprise: 0 }, { ...policy, consistencyK: 7 }]) {
    assert.throws(() => parsePhaseTwoPolicy(input), /invalid Phase 2 policy|consistency k/);
  }
});

test("Admission rejects coverage, source/lane, score, aggregates and provenance drift", () => {
  const original = inputs();
  for (const [path, value, message] of [
    [["broad", "results"], original.broad.results.slice(1), /incomplete/],
    [["broad", "results", 0], original.broad.results[1], /incomplete/],
    [["deep", "fixtures"], [...original.deep.fixtures ?? [], "positive-15"], /incomplete/],
    [["deep", "draws"], 3, /incomplete/], [["broad", "fixtureSetHash"], "wrong", /subset hash/], [["broad", "fixtureDefectClasses"], {}, /fixture families/],
    [["broad", "holdout"], "exclude", /holdout/], [["broad", "gateClass"], "D", /gate class R/],
    [["broad", "promptHash"], "old", /stale/], [["broad", "scorerHash"], "old", /stale/], [["broad", "anticheatVersion"], 1, /stale/],
    [["deep", "gitSha"], "b".repeat(40), /lane\/source/], [["deep", "model"], "other", /lane\/source/],
    [["deep", "provider"], "other", /lane\/source/], [["broad", "provider"], "unknown", /unknown or private/], [["broad", "privateEnvironment"], true, /public/],
    [["broad", "runnerEnvironment"], "[]", /guarded/],
    [["broad", "results", 0, "score", "mustFindHits"], 0, /stored findings/],
    [["broad", "results", 0, "matchEvidence", 0, "findingIndex"], 99, /final match evidence/],
    [["broad", "results", 0, "candidateMatchEvidence"], [{ pattern: "foreign", findingIndex: 0 }], /candidate match evidence/],
    [["broad", "results", 0, "score", "criticPruneError"], true, /critic prune error/],
    [["broad", "results", 0, "score", "robustness"], undefined, /retain anti-cheat provenance/],
    [["broad", "results", 0, "score", "robustness", "missingProvenanceCount"], 1, /unmatched anti-cheat evidence/],
    [["broad", "results", 0, "score", "robustness", "rawExposureCount"], 1, /counts do not match/],
    [["broad", "runnerEnvironment"], JSON.stringify([["NEEDLEFISH_EPHEMERAL_HOME", "1"], ["NEEDLEFISH_EPHEMERAL_HOME", "1"]]), /duplicate keys/],
    [["broad", "results", 0, "calls"], 0, /retain anti-cheat provenance/],
    [["broad", "aggregates", "recall"], 0, /aggregate recall/],
    [["broad", "aggregates", "mustFindHitRate"], 0, /aggregate mustFindHitRate/],
    [["broad", "aggregates", "mustFindHitRateByFixture"], {}, /aggregate mustFindHitRateByFixture/],
    [["broad", "aggregates", "recallByDefectClass"], {}, /aggregate recallByDefectClass/],
    [["broad", "aggregates", "lineAnchorValidRateByDefectClass"], {}, /aggregate lineAnchorValidRateByDefectClass/], [["broad", "aggregates", "recallByTier"], {}, /aggregate recall records/],
    [["broad", "results", 0, "operationalFailure"], "spawn codex EACCES", /operational failures/],
    [["broad", "aggregates", "cheatDetectedCount"], 1, /anti-cheat/],
  ] satisfies readonly [readonly (string | number)[], unknown, RegExp][]) {
    const changed = structuredClone(original); edit(changed, path, value);
    if (path.join(".") === "broad.results.0.calls") edit(changed, ["broad", "results", 0, "score", "robustness"], undefined);
    assert.throws(() => admitPhaseTwoReports(changed, specs, policy), message);
  }
  const deadline = structuredClone(original);
  edit(deadline, ["broad", "results", 0, "operationalFailure"], "spawn codex ETIMEDOUT. retry");
  admitPhaseTwoReports(deadline, specs, policy);
});

test("Docs provenance exemption is limited to canonical docs fast-path zero-call draws", () => {
  const data = inputs();
  for (const draw of data.broad.results.filter((draw) => draw.fixtureId === "docs")) {
    Reflect.set(draw, "fastPath", "docs"); Reflect.set(draw, "calls", 0); Reflect.deleteProperty(draw.score, "robustness");
  }
  admitPhaseTwoReports(data, specs, policy);
  const forged = structuredClone(data);
  Reflect.set(forged.broad.results[0], "fastPath", "docs"); Reflect.set(forged.broad.results[0], "calls", 0);
  assert.throws(() => admitPhaseTwoReports(forged, specs, policy), /invalid docs fast path/);
  const nonzero = structuredClone(data);
  const docs = nonzero.broad.results.find((draw) => draw.fixtureId === "docs"); assert.ok(docs);
  Reflect.set(docs, "calls", 1);
  assert.throws(() => admitPhaseTwoReports(nonzero, specs, policy), /invalid docs fast path/);
});

test("Admission rejects successful zero-call draws without a canonical docs fast path", () => {
  for (const [lane, fixtureId] of [
    ["broad", "positive-0"], ["deep", "positive-0"], ["broad", "negative"],
    ["broad", "honeypot"], ["broad", "docs"],
  ] as const) {
    const data = inputs();
    const draw = data[lane].results.find((draw) => draw.fixtureId === fixtureId); assert.ok(draw);
    Reflect.set(draw, "calls", 0);
    assert.equal(draw.score.formatOk, true);
    assert.ok(draw.score.robustness);
    assert.equal("fastPath" in draw, false);
    const campaign = { broad: parsePhaseTwoReport(data.broad), deep: parsePhaseTwoReport(data.deep) };
    Reflect.set(data.oracle, "identity", phaseTwoOracleIdentity(campaign, specs));
    assert.equal(evaluatePhaseTwoQualification(campaign, specs, policy, data.oracle).eligible, true);
    assert.throws(() => admitPhaseTwoReports(campaign, specs, policy), /successful zero-call draw requires docs fast path/);
  }
});

for (const failure of ["invalid model JSON", "spawn codex ETIMEDOUT. retry"]) {
  test(`Zero-call failed draws retain a failed measurement artifact: ${failure}`, async () => {
    const data = stored();
    try {
      const draw = data.input.broad.results[0];
      const spec = specs[0];
      Reflect.set(draw, "calls", 0);
      Reflect.set(draw, "findings", []);
      Reflect.set(draw, "matchEvidence", matchEvidence([], spec.expected));
      Reflect.set(draw, "score", score(null, spec.expected, spec.id, failure, undefined, "invalid output", [{
        surface: "raw_failure", content: "invalid output", passKind: "review", passIndex: 0,
        promptAttempt: 1, runnerAttempt: 1, outcome: "parse_failed",
      }]));
      if (failure.includes("ETIMEDOUT")) Reflect.set(draw, "operationalFailure", failure);
      assert.ok(draw.score.robustness);
      assert.equal(draw.score.formatOk, false);
      Object.assign(data.input.broad.aggregates, {
        recall: 50 / 51, invalidJsonRate: 1 / 60, verdictMatchRate: 59 / 60, lineAnchorValidRate: 59 / 60,
        recallByFixture: { ...data.input.broad.aggregates.recallByFixture, [spec.id]: 2 / 3 },
        recallByTier: { ...data.input.broad.aggregates.recallByTier, t1: 44 / 45 },
      });
      Reflect.set(data.input.oracle.adjudication, "rows", data.input.oracle.adjudication.rows.filter((row) => row.fixtureId !== draw.fixtureId || row.draw !== draw.draw));
      Reflect.set(data.input.oracle, "identity", phaseTwoOracleIdentity(data.input, specs));
      const campaign = { broad: parsePhaseTwoReport(data.input.broad), deep: parsePhaseTwoReport(data.input.deep) };
      admitPhaseTwoReports(campaign, specs, policy);
      const result = evaluatePhaseTwoQualification(campaign, specs, policy, data.input.oracle);
      assert.equal(result.eligible, false);
      assert.ok(result.reasons.includes("invalid or compromised draw"));
      [data.input.broad, data.input.deep, data.input.oracle, data.input.policy].forEach((value, index) => writeFileSync(data.paths[index], JSON.stringify(value)));
      const before = data.paths.map((path) => readFileSync(path));
      assert.equal(await main([...data.paths, data.output], () => specs), 1);
      const measurement = JSON.parse(readFileSync(data.output, "utf8"));
      assert.equal(measurement.status, "measurement_only");
      assert.deepEqual(measurement.result, result);
      assert.deepEqual(data.paths.map((path) => readFileSync(path)), before);
      const missingProvenance = structuredClone(campaign);
      Reflect.deleteProperty(missingProvenance.broad.results[0].score, "robustness");
      assert.throws(() => admitPhaseTwoReports(missingProvenance, specs, policy), /retain anti-cheat provenance/);
    } finally { rmSync(data.directory, { recursive: true, force: true }); }
  });
}

test("Actual measurement main preserves unknown quality as failure artifact and rejects changed oracle binding", async (context) => {
  const data = stored();
  try {
    const unresolved = structuredClone(data.input.oracle);
    Reflect.set(unresolved.adjudication, "rows", []);
    writeFileSync(data.paths[2], JSON.stringify(unresolved));
    const qualityFail = cli(data.directory, [...data.paths, data.output], true);
    assert.equal(qualityFail.status, 1, qualityFail.stderr);
    const failed = JSON.parse(readFileSync(data.output, "utf8"));
    context.diagnostic(JSON.stringify({ control: "actual_cli_quality_unknown", status: qualityFail.status, stderr: qualityFail.stderr, measurement: failed }));
    assert.equal(failed.status, "measurement_only");
    assert.equal(failed.result.eligible, false);
    assert.equal(failed.result.actionablePrecision.status, "unknown");
    assert.match(failed.result.reasons.join("\n"), /unknown required metric/);
    rmSync(data.output);
    const partialGold = structuredClone(data.input.oracle);
    assert.ok(partialGold.severityGold);
    Reflect.set(partialGold.severityGold, "labels", partialGold.severityGold.labels.slice(0, -1));
    writeFileSync(data.paths[2], JSON.stringify(partialGold));
    assert.equal(await main([...data.paths, data.output], () => specs), 1);
    const partial = JSON.parse(readFileSync(data.output, "utf8"));
    assert.deepEqual(partial.result.severityLabelCoverage, { status: "measured", value: 48 / 51, numerator: 48, denominator: 51 });
    assert.ok(partial.result.reasons.includes("failed floor: minSeverityLabelCoverage"));
    rmSync(data.output);
    const missingScoringIdentity = structuredClone(data.input.oracle);
    Reflect.deleteProperty(missingScoringIdentity.identity, "fixtureScoringSha256");
    for (const invalid of [{ ...data.input.oracle, schemaVersion: 1 }, missingScoringIdentity]) {
      const bytes = JSON.stringify(invalid);
      writeFileSync(data.paths[2], bytes);
      const rejected = cli(data.directory, [...data.paths, data.output], true);
      assert.equal(rejected.status, 1, rejected.stderr);
      assert.match(rejected.stderr, /invalid Phase 2 quality oracle/);
      assert.equal(existsSync(data.output), false);
      assert.equal(readFileSync(data.paths[2], "utf8"), bytes);
    }
    writeFileSync(data.paths[2], JSON.stringify(data.input.oracle));
    const unfinished = { ...data.input.broad, results: data.input.broad.results.slice(1) };
    writeFileSync(data.paths[0], JSON.stringify(unfinished));
    await assert.rejects(main([...data.paths, data.output], () => specs), /incomplete fixture/);
    assert.equal(existsSync(data.output), false);
    const metadata = { ...data.input.broad, unusedMetadata: "changed identity" };
    writeFileSync(data.paths[0], JSON.stringify(metadata));
    await assert.rejects(main([...data.paths, data.output], () => specs), /oracle identity mismatch/);
    assert.equal(existsSync(data.output), false);
    assert.equal(parsePhaseTwoReport(metadata), metadata);
    writeFileSync(data.paths[0], JSON.stringify(data.input.broad));
    writeFileSync(data.paths[2], "null");
    await assert.rejects(main([...data.paths, data.output], () => specs), /invalid Phase 2 quality oracle/);
    assert.equal(existsSync(data.output), false);
  } finally { rmSync(data.directory, { recursive: true, force: true }); }
});

test("Actual CLI rejects malformed, unbounded and nonregular input without overwriting inputs", async () => {
  const data = stored();
  try {
    const before = data.paths.map((path) => readFileSync(path));
    for (const args of [[], [...data.paths], [...data.paths, data.output, "--extra"], ["--bad", ...data.paths]]) {
      const result = cli(data.directory, args); assert.equal(result.status, 1); assert.match(result.stderr, /Usage:/);
    }
    for (const [path, bytes, message] of [
      [data.paths[0], Buffer.from([0xff]), /encoded data|UTF/],
      [data.paths[0], Buffer.from("{"), /JSON/],
      [data.paths[0], Buffer.from("null"), /invalid Phase 2 report/],
    ] satisfies readonly [string, Buffer, RegExp][]) {
      writeFileSync(path, bytes);
      const result = cli(data.directory, [...data.paths, data.output]);
      assert.equal(result.status, 1); assert.match(result.stderr, message); assert.equal(existsSync(data.output), false);
    }
    writeFileSync(data.paths[0], before[0]);
    for (const path of [data.directory, join(data.directory, "missing.json")]) {
      const result = cli(data.directory, [path, ...data.paths.slice(1), data.output]);
      assert.equal(result.status, 1); assert.match(result.stderr, /regular file|ENOENT/); assert.equal(existsSync(data.output), false);
    }
    const huge = join(data.directory, "large.json"); writeFileSync(huge, ""); truncateSync(huge, MAX_PHASE_TWO_INPUT_BYTES + 1);
    const large = cli(data.directory, [huge, ...data.paths.slice(1), data.output]);
    assert.equal(large.status, 1); assert.match(large.stderr, /byte cap/);
    if (process.platform !== "win32") {
      const fifo = join(data.directory, "fifo"); const make = spawnSync("/usr/bin/mkfifo", [fifo]); assert.equal(make.status, 0);
      const result = cli(data.directory, [fifo, ...data.paths.slice(1), data.output]);
      assert.equal(result.status, 1); assert.match(result.stderr, /regular file/);
    }
    const same = cli(data.directory, [...data.paths, data.paths[0]], true);
    assert.equal(same.status, 1); assert.match(same.stderr, /EEXIST/);
    assert.deepEqual(data.paths.map((path) => readFileSync(path)), before);
    assert.equal(existsSync(data.output), false);
  } finally { rmSync(data.directory, { recursive: true, force: true }); }
});
