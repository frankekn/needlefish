import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { importManifest, parseManifest, sha256, type ExternalManifest } from "./manifest.js";
import { attemptSHA256, normalizeFindings, parseEvaluator, parseProductResults, scoreProductResults, sourceBinding, type Evaluator, type ProductResults } from "./results.js";
import { main as importMain } from "./import.js";
import { main as scoreMain } from "./score.js";

const sampleDirectory = fileURLToPath(new URL("./samples/", import.meta.url));
const sample = (name = "swrbench-pytest-3248.json") => parseManifest(readFileSync(join(sampleDirectory, name), "utf8"));
const hash = "a".repeat(64);
function fixture(paths = ["value.ts"], content = { base: "export const value = 1;\nexport const other = 1;\n", head: "export const value = 0;\nexport const other = 1;\n" }) {
  const root = mkdtempSync(join(tmpdir(), "needlefish-external-score-"));
  const repo = join(root, "repo");
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
  execFileSync("git", ["init", "-q", repo], { env });
  const git = (...args: string[]) => execFileSync("git", ["--no-optional-locks", "-C", repo, ...args], { encoding: "utf8", env }).trimEnd();
  git("config", "user.name", "Synthetic"); git("config", "user.email", "synthetic@example.invalid"); git("config", "commit.gpgsign", "false");
  for (const path of paths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content.base);
  }
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD"); const baseTree = git("rev-parse", "HEAD^{tree}");
  for (const path of paths) writeFileSync(join(repo, path), content.head);
  git("commit", "-qam", "head");
  const head = git("rev-parse", "HEAD");
  const diff = execFileSync("git", ["--no-optional-locks", "-C", repo, "diff", "--full-index", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--no-color", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", base, head, "--"], { env, encoding: "utf8" });
  const manifest: ExternalManifest = {
    ...sample(), source: { ...sample().source, instanceId: "synthetic-value", canonicalRepo: "synthetic/value" },
    snapshot: { kind: "frozen", sourceBaseSHA: base, reviewBaseSHA: base, reviewHeadSHA: head, observedFinalHeadSHA: null, mergeBaseSHA: base, commitSHAs: [head], baseTreeSHA: baseTree, headTreeSHA: git("rev-parse", "HEAD^{tree}"), diffSHA256: sha256(diff) },
    reviewText: { kind: "frozen", title: "Update a value", description: "Change the value.", policy: "Review correctness.", titleSHA256: sha256("Update a value"), descriptionSHA256: sha256("Change the value."), policySHA256: sha256("Review correctness.") },
    evaluator: { label: "positive", goldCount: 1, goldLocations: "missing", provenance: "Synthetic source observation, not a dataset sample" },
  };
  const admitted = importManifest(manifest, repo);
  if (admitted.status !== "source-ready") { rmSync(root, { recursive: true, force: true }); assert.fail(JSON.stringify(admitted)); }
  const binding = sourceBinding(manifest, admitted.reviewer);
  const results: ProductResults = {
    schemaVersion: 1, binding, product: { name: "Needlefish", version: "synthetic-1", configurationSHA256: hash, source: { identity: "synthetic-result.json", sha256: hash } },
    attempts: [{ id: "attempt-1", status: "completed", format: "needlefish-capture-v1", findings: [{ id: "f1", title: "Zero divisor", whyItBreaks: "A zero value causes division by zero.", file: "value.ts", side: "head", lineStart: 1, lineEnd: 1 }] }],
  };
  const evaluator: Evaluator = {
    schemaVersion: 1, binding, independent: { identity: "synthetic-independent-curator", version: "1", sourceSHA256: hash },
    gold: { status: "ready", provenance: "Synthetic gold frozen before results", findings: [{ id: "g1", description: "Zero causes division by zero", location: { path: "value.ts", side: "head", start: 1, end: 1 } }] },
    attempts: [{ id: "attempt-1", attemptSHA256: attemptSHA256(results.attempts[0]), adjudications: [{ findingId: "f1", descriptionGoldIds: ["g1"], unmatched: "unresolved", rationale: "The finding describes the same zero-divisor defect." }] }],
  };
  const refresh = () => { const attempt = evaluator.attempts[0]; if (attempt) attempt.attemptSHA256 = attemptSHA256(results.attempts[0]); };
  const score = () => scoreProductResults(parseManifest(JSON.stringify(manifest)), parseEvaluator(JSON.stringify(evaluator)), parseProductResults(JSON.stringify(results)), repo);
  return { root, repo, manifest, results, evaluator, score, refresh, admitted, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function metrics(f: ReturnType<typeof fixture>) {
  const value = f.score().attempts[0];
  if (!value || !("metrics" in value) || !value.metrics) assert.fail(JSON.stringify(value));
  return value.metrics;
}

test("all three product adapters yield identical literal metrics and retained identities", () => {
  const f = fixture();
  try {
    const expected = { matched: 1, missed: 0, duplicate: 0, falsePositive: 0, legitimateUnmatched: 0, unresolved: 0, findingCount: 1, goldCount: 1, recall: { numerator: 1, denominator: 1, value: 1 }, precision: { numerator: 1, denominator: 1, value: 1 } };
    assert.deepEqual(metrics(f), expected);
    f.results.product.name = "Codex review";
    f.results.attempts = [{ id: "attempt-1", status: "completed", format: "codex-review-capture-v1", findings: [{ id: "f1", title: "Zero divisor", body: "A zero value causes division by zero.", code_location: { file: "value.ts", side: "head", start: 1, end: 1 } }] }];
    f.refresh(); assert.deepEqual(metrics(f), expected);
    f.results.product.name = "CodeRabbit";
    f.results.attempts = [{ id: "attempt-1", status: "completed", format: "coderabbit-capture-v1", findings: [{ id: "f1", body: "Zero divisor. A zero value causes division by zero.", path: "value.ts", side: "RIGHT", start_line: 1, line: 1 }] }];
    f.refresh(); assert.deepEqual(metrics(f), expected);
    assert.deepEqual(f.score().product, f.results.product);
    assert.deepEqual(f.score().evaluator, f.evaluator.independent);
    assert.equal(f.score().evaluatorSHA256, sha256(JSON.stringify(f.evaluator)));
    assert.equal(f.score().resultsSHA256, sha256(JSON.stringify(f.results)));
  } finally { f.cleanup(); }
});

test("same description at wrong file, side or line never matches and is not automatic FP", () => {
  const f = fixture();
  try {
    const attempt = f.results.attempts[0];
    if (attempt.status !== "completed" || attempt.format !== "needlefish-capture-v1") assert.fail();
    const patches: Partial<(typeof attempt.findings)[number]>[] = [{ file: "wrong.ts" }, { file: "Value.ts" }, { side: "base" }, { lineStart: 2, lineEnd: 2 }, { lineStart: 1, lineEnd: 2 }];
    for (const patch of patches) {
      attempt.findings[0] = { id: "f1", title: "Zero divisor", whyItBreaks: "A zero value causes division by zero.", file: "value.ts", side: "head", lineStart: 1, lineEnd: 1, ...patch };
      f.refresh();
      assert.deepEqual(metrics(f), { matched: 0, missed: 1, duplicate: 0, falsePositive: 0, legitimateUnmatched: 0, unresolved: 1, findingCount: 1, goldCount: 1, recall: { numerator: 0, denominator: 1, value: 0 }, precision: { numerator: 0, denominator: 1, value: null } });
    }
  } finally { f.cleanup(); }
});

test("one finding cannot satisfy two golds; allocation reassigns to maximize one-to-one matches", () => {
  const f = fixture();
  try {
    if (f.evaluator.gold.status !== "ready") assert.fail();
    f.evaluator.gold.findings.push({ ...f.evaluator.gold.findings[0], id: "g2" });
    f.evaluator.attempts[0].adjudications[0].descriptionGoldIds.push("g2");
    assert.equal(metrics(f).matched, 1); assert.equal(metrics(f).missed, 1); assert.equal(metrics(f).recall.value, 0.5);
    const attempt = f.results.attempts[0];
    if (attempt.status !== "completed" || attempt.format !== "needlefish-capture-v1") assert.fail();
    attempt.findings.push({ ...attempt.findings[0], id: "f2" });
    f.evaluator.attempts[0].adjudications.push({ findingId: "f2", descriptionGoldIds: ["g1"], unmatched: "unresolved", rationale: "Independently describes first defect only." });
    f.refresh(); assert.equal(metrics(f).matched, 2); assert.equal(metrics(f).missed, 0);
  } finally { f.cleanup(); }
});

for (const disposition of ["unresolved", "false_positive"] as const) {
  test(`eligible duplicate metrics ignore ${disposition} disposition and finding order`, () => {
    const f = fixture();
    try {
      const attempt = f.results.attempts[0];
      if (attempt.status !== "completed" || attempt.format !== "needlefish-capture-v1") assert.fail();
      attempt.findings.push({ ...attempt.findings[0], id: "f2" });
      f.evaluator.attempts[0].adjudications[0].unmatched = disposition;
      f.evaluator.attempts[0].adjudications.push({ findingId: "f2", descriptionGoldIds: ["g1"], unmatched: "legitimate", rationale: "The same gold defect is independently confirmed." });
      f.refresh();
      const forward = metrics(f);
      attempt.findings.reverse();
      f.refresh();
      const reversed = metrics(f);
      assert.deepEqual(forward, reversed);
      assert.deepEqual(forward, { matched: 1, missed: 0, duplicate: 1, falsePositive: 0, legitimateUnmatched: 0, unresolved: 0, findingCount: 2, goldCount: 1, recall: { numerator: 1, denominator: 1, value: 1 }, precision: { numerator: 1, denominator: 2, value: 0.5 } });
      assert.equal(f.score().rubric, "external-description-location-v2");
    } finally { f.cleanup(); }
  });
}

test("description equivalence and explicit sibling/FP judgments control actual denominators", () => {
  const f = fixture();
  try {
    const attempt = f.results.attempts[0];
    if (attempt.status !== "completed" || attempt.format !== "needlefish-capture-v1") assert.fail();
    attempt.findings.push({ ...attempt.findings[0], id: "sibling" }, { ...attempt.findings[0], id: "false" });
    f.evaluator.attempts[0].adjudications.push(
      { findingId: "sibling", descriptionGoldIds: [], unmatched: "legitimate", rationale: "A separate independently verified defect absent from frozen gold." },
      { findingId: "false", descriptionGoldIds: [], unmatched: "false_positive", rationale: "Independent source inspection disproves this claim." },
    );
    f.refresh();
    assert.deepEqual(metrics(f), { matched: 1, missed: 0, duplicate: 0, falsePositive: 1, legitimateUnmatched: 1, unresolved: 0, findingCount: 3, goldCount: 1, recall: { numerator: 1, denominator: 1, value: 1 }, precision: { numerator: 2, denominator: 3, value: 2 / 3 } });
    f.evaluator.attempts[0].adjudications[0].descriptionGoldIds = [];
    assert.equal(metrics(f).matched, 0); assert.equal(metrics(f).unresolved, 1); assert.equal(metrics(f).precision.value, null);
    f.evaluator.attempts[0].adjudications.pop();
    assert.equal(f.score().attempts[0].status, "unscorable"); assert.equal(f.score().attempts[0].metrics, null);
  } finally { f.cleanup(); }
});

test("empty gold and empty findings never invent perfect rates; no gold locations is unscorable", () => {
  const f = fixture();
  try {
    f.evaluator.gold = { status: "unavailable", reason: "gold_locations_missing" };
    f.evaluator.attempts = [];
    assert.equal(f.score().attempts[0].status, "unscorable"); assert.equal(f.score().attempts[0].metrics, null);
    f.evaluator.gold = { status: "ready", provenance: "Independent clean cohort", findings: [] };
    f.results.attempts = [{ id: "attempt-1", status: "completed", format: "needlefish-capture-v1", findings: [] }];
    assert.deepEqual(metrics(f), { matched: 0, missed: 0, duplicate: 0, falsePositive: 0, legitimateUnmatched: 0, unresolved: 0, findingCount: 0, goldCount: 0, recall: { numerator: 0, denominator: 0, value: null }, precision: { numerator: 0, denominator: 0, value: null } });
  } finally { f.cleanup(); }
});

test("all failure and unfinished outcomes retain reasons and no clean metrics", () => {
  const f = fixture();
  try {
    const statuses: ("operational" | "incomplete" | "skipped" | "truncated" | "raw")[] = ["operational", "incomplete", "skipped", "truncated", "raw"];
    f.results.attempts = statuses.map((status, i) => ({ id: `attempt-${i}`, status, reason: "Original failure" }));
    f.evaluator.attempts = [];
    assert.deepEqual(f.score().attempts.map((a) => ({ status: a.status, metrics: a.metrics })), ["operational", "incomplete", "skipped", "truncated", "raw"].map((status) => ({ status, metrics: null })));
  } finally { f.cleanup(); }
});

test("identity drift, missing source, unknown formats, duplicate or foreign adjudications fail closed", () => {
  const f = fixture();
  try {
    const original = structuredClone(f.results);
    for (const candidate of [
      { ...original, product: { ...original.product, source: undefined } },
      { ...original, product: { ...original.product, name: "Unknown" } },
      { ...original, attempts: [...original.attempts, original.attempts[0]] },
      { ...original, attempts: [{ ...original.attempts[0], format: "native-markdown" }] },
      { ...original, privateToken: "PRIVATE-DO-NOT-EXPORT" },
      { ...original, evaluator: f.evaluator },
      { ...original, product: { ...original.product, version: " " } },
      { ...original, attempts: [{ id: "a", status: "raw", reason: "markdown", findings: [] }] },
    ]) assert.throws(() => parseProductResults(JSON.stringify(candidate)), /invalid_product_results|duplicate_attempt/);
    f.results.binding = { ...original.binding, reviewerSHA256: "b".repeat(64) };
    assert.throws(f.score, /source_identity_mismatch/); f.results.binding = original.binding;
    const g = fixture();
    try {
      g.evaluator.attempts[0].attemptSHA256 = "b".repeat(64); assert.throws(g.score, /evaluator_attempt_identity_mismatch/);
      g.refresh(); g.evaluator.attempts[0].adjudications[0].findingId = "foreign"; assert.throws(g.score, /foreign_adjudication_finding/);
      g.evaluator.attempts[0].adjudications[0].findingId = "f1";
      g.evaluator.attempts[0].adjudications[0].descriptionGoldIds = ["foreign"]; assert.throws(g.score, /foreign_adjudication_gold/);
      g.evaluator.attempts[0].adjudications[0].descriptionGoldIds = ["g1"];
      if (g.evaluator.gold.status !== "ready") assert.fail();
      g.evaluator.gold.findings[0].location.end = 99; assert.throws(g.score, /gold_location_outside_snapshot/);
    } finally { g.cleanup(); }
    assert.throws(() => parseEvaluator(JSON.stringify({ ...f.evaluator, attempts: [f.evaluator.attempts[0], f.evaluator.attempts[0]] })), /duplicate_evaluator_attempt/);
    assert.throws(() => parseEvaluator(JSON.stringify({ ...f.evaluator, gold: { status: "ready", provenance: "missing locations", findings: [{ id: "g1", description: "No location" }] } })), /invalid_evaluator/);
    const attempt = original.attempts[0];
    if (attempt.status !== "completed" || attempt.format !== "needlefish-capture-v1" || f.evaluator.gold.status !== "ready") assert.fail();
    assert.throws(() => parseProductResults(JSON.stringify({ ...original, attempts: [{ ...attempt, findings: [...attempt.findings, attempt.findings[0]] }] })), /duplicate_finding/);
    assert.throws(() => parseProductResults(JSON.stringify({ ...original, attempts: [{ ...attempt, findings: [{ ...attempt.findings[0], title: " ", whyItBreaks: " " }] }] })), /invalid_product_results/);
    assert.throws(() => parseProductResults(JSON.stringify({ ...original, attempts: [{ ...attempt, findings: [{ ...attempt.findings[0], file: "../private.ts" }] }] })), /invalid_location/);
    assert.throws(() => parseProductResults(JSON.stringify({ ...original, attempts: [{ ...attempt, findings: [{ ...attempt.findings[0], lineStart: 2, lineEnd: 1 }] }] })), /invalid_location/);
    const readyGold = f.evaluator.gold;
    assert.throws(() => parseEvaluator(JSON.stringify({ ...f.evaluator, gold: { ...readyGold, findings: [...readyGold.findings, readyGold.findings[0]] } })), /duplicate_gold/);
    assert.throws(() => parseEvaluator(JSON.stringify({ ...f.evaluator, attempts: [{ ...f.evaluator.attempts[0], adjudications: [f.evaluator.attempts[0].adjudications[0], f.evaluator.attempts[0].adjudications[0]] }] })), /duplicate_adjudication/);
    assert.throws(() => parseEvaluator(JSON.stringify({ ...f.evaluator, privateValue: "PRIVATE-DO-NOT-EXPORT" })), /invalid_evaluator/);
  } finally { f.cleanup(); }
});

test("real CLI import and score roundtrip preserves reviewer bytes and refuses overwrites and invalid inputs", () => {
  const f = fixture();
  try {
    const manifestPath = join(f.root, "manifest.json"); const evaluatorPath = join(f.root, "evaluator.json"); const resultsPath = join(f.root, "results.json"); const output = join(f.root, "scores.json");
    writeFileSync(manifestPath, JSON.stringify(f.manifest)); writeFileSync(evaluatorPath, JSON.stringify(f.evaluator)); writeFileSync(resultsPath, JSON.stringify(f.results));
    const imported = join(f.root, "imported");
    const runCLI = (script: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url)), ...args], { encoding: "utf8", timeout: 20_000 });
    const first = runCLI("./import.ts", [manifestPath, imported, "--repo", f.repo]);
    assert.equal(first.status, 0, first.stderr); assert.equal(JSON.parse(first.stdout).status, "source-ready");
    const reviewerBytes = readFileSync(join(imported, "reviewer", "input.json"), "utf8");
    const score = runCLI("./score.ts", [manifestPath, evaluatorPath, resultsPath, output, "--repo", f.repo]);
    assert.equal(score.status, 0, score.stderr); assert.equal(JSON.parse(score.stdout).status, "evaluated");
    const report = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(report.attempts[0].metrics.matched, 1); assert.equal(report.attempts[0].metrics.falsePositive, 0); assert.equal(report.attempts[0].metrics.recall.denominator, 1);
    assert.equal(readFileSync(join(imported, "reviewer", "input.json"), "utf8"), reviewerBytes);
    assert.equal(/synthetic-independent-curator|descriptionGoldIds|sourceSHA256/.test(reviewerBytes), false);
    const overwrite = runCLI("./score.ts", [manifestPath, evaluatorPath, resultsPath, output, "--repo", f.repo]); assert.equal(overwrite.status, 1); assert.match(overwrite.stderr, /EEXIST/);
    const invalidOutput = join(f.root, "invalid-output");
    writeFileSync(resultsPath, '{"raw":"truncated"');
    assert.throws(() => scoreMain([manifestPath, evaluatorPath, resultsPath, invalidOutput, "--repo", f.repo]), /JSON|position|Expected/); assert.equal(existsSync(invalidOutput), false);
    writeFileSync(resultsPath, " ".repeat(2_000_001)); assert.throws(() => scoreMain([manifestPath, evaluatorPath, resultsPath, invalidOutput]), /input_too_large/);
    assert.throws(() => scoreMain([manifestPath, evaluatorPath, f.root, invalidOutput]), /input_not_regular_file/);
    writeFileSync(resultsPath, Buffer.from([0xff])); assert.throws(() => scoreMain([manifestPath, evaluatorPath, resultsPath, invalidOutput]), /encoded data|UTF-8/);
    if (process.platform !== "win32") {
      const fifo = join(f.root, "results.fifo"); execFileSync("mkfifo", [fifo]);
      assert.throws(() => scoreMain([manifestPath, evaluatorPath, fifo, invalidOutput]), /input_not_regular_file/);
    }
  } finally { f.cleanup(); }
});

test("existing real sample bytes remain excluded even with supplied result and gold", () => {
  const f = fixture();
  try {
    for (const name of ["swrbench-pytest-3248.json", "martian-calcom-8087.json"]) {
      const bytes = readFileSync(join(sampleDirectory, name));
      const manifest = sample(name);
      const report = scoreProductResults(manifest, f.evaluator, f.results, f.repo);
      assert.equal(report.status, "excluded"); assert.equal(report.attempts[0].status, "excluded"); assert.equal(report.attempts[0].metrics, null);
      assert.equal(sha256(readFileSync(join(sampleDirectory, name))), sha256(bytes));
      const manifestPath = join(f.root, name); writeFileSync(manifestPath, bytes);
      const directory = join(f.root, `${name}-import`); importMain([manifestPath, directory]);
      assert.equal(existsSync(join(directory, "reviewer")), false);
    }
  } finally { f.cleanup(); }
});


test("real importer and three score CLIs preserve Unicode, route, whitespace and literal Git pathspec names", () => {
  const paths = ["app/[id]/page.tsx", "space name.ts", "(route)/page.tsx", "中文.ts", "emoji😀.ts", "-option.ts", '"quotes".ts', "cash$(touch PWNED).ts", "glob[12].ts", "glob1.ts", "glob2.ts", "star*.ts", "star1.ts", "question?.ts", "question1.ts", "עברית.ts", "العربية.ts", "join\u200d.ts", "nonjoin\u200c.ts", "word\u2060.ts", "bom\ufeff.ts"];
  const f = fixture(paths);
  try {
    const manifestPath = join(f.root, "manifest.json"); const evaluatorPath = join(f.root, "gold.json"); const resultsPath = join(f.root, "results.json");
    writeFileSync(manifestPath, JSON.stringify(f.manifest));
    const runCLI = (script: string, args: string[]) => spawnSync(process.execPath, ["--import", "tsx", fileURLToPath(new URL(script, import.meta.url)), ...args], { encoding: "utf8", timeout: 20_000 });
    const imported = join(f.root, "imported");
    const importedCLI = runCLI("./import.ts", [manifestPath, imported, "--repo", f.repo]);
    assert.equal(importedCLI.status, 0, importedCLI.stderr);
    assert.equal(JSON.parse(importedCLI.stdout).status, "source-ready");
    const reviewerBytes = readFileSync(join(imported, "reviewer", "input.json"), "utf8");
    const reviewer = JSON.parse(reviewerBytes);
    assert.deepEqual(reviewer.headFiles.map((file: { path: string }) => file.path).sort(), [...paths].sort());
    assert.deepEqual(reviewer.lineMap, f.admitted.reviewer.lineMap);
    for (const path of paths) {
      assert.deepEqual(reviewer.lineMap.filter((range: { path: string }) => range.path === path), [{ path, oldStart: 1, oldLines: 2, newStart: 1, newLines: 2 }]);
      assert.deepEqual(reviewer.baseFiles.find((file: { path: string }) => file.path === path), { path, mode: "100644", content: "export const value = 1;\nexport const other = 1;\n" });
      assert.deepEqual(reviewer.headFiles.find((file: { path: string }) => file.path === path), { path, mode: "100644", content: "export const value = 0;\nexport const other = 1;\n" });
    }
    const products: ProductResults["product"]["name"][] = ["Needlefish", "Codex review", "CodeRabbit"];
    for (const product of products) {
      f.results.product.name = product;
      const findings = paths.map((path, i) => ({ id: `f${i}`, path }));
      if (product === "Needlefish") f.results.attempts = [{ id: "attempt-1", status: "completed", format: "needlefish-capture-v1", findings: findings.map((f) => ({ id: f.id, file: f.path, side: "head", lineStart: 1, lineEnd: 1, title: "Zero", whyItBreaks: "Zero divisor" })) }];
      if (product === "Codex review") f.results.attempts = [{ id: "attempt-1", status: "completed", format: "codex-review-capture-v1", findings: findings.map((f) => ({ id: f.id, title: "Zero", body: "Zero divisor", code_location: { file: f.path, side: "head", start: 1, end: 1 } })) }];
      if (product === "CodeRabbit") f.results.attempts = [{ id: "attempt-1", status: "completed", format: "coderabbit-capture-v1", findings: findings.map((f) => ({ id: f.id, body: "Zero divisor", path: f.path, side: "RIGHT", start_line: 1, line: 1 })) }];
      f.evaluator.gold = { status: "ready", provenance: "Synthetic independently frozen locations", findings: paths.map((path, i) => ({ id: `g${i}`, description: "Zero divisor", location: { path, side: "head", start: 1, end: 1 } })) };
      f.evaluator.attempts[0].adjudications = findings.map((f, i) => ({ findingId: f.id, descriptionGoldIds: [`g${i}`], unmatched: "unresolved", rationale: "The description identifies this independent synthetic defect." }));
      f.refresh();
      writeFileSync(evaluatorPath, JSON.stringify(f.evaluator)); writeFileSync(resultsPath, JSON.stringify(f.results));
      const output = join(f.root, `${product}-score.json`);
      const scored = runCLI("./score.ts", [manifestPath, evaluatorPath, resultsPath, output, "--repo", f.repo]);
      assert.equal(scored.status, 0, scored.stderr); assert.equal(JSON.parse(scored.stdout).status, "evaluated");
      const report = JSON.parse(readFileSync(output, "utf8"));
      assert.equal(report.attempts[0].metrics.matched, paths.length);
      assert.deepEqual(report.attempts[0].matches, findings.map((f, i) => ({ findingId: f.id, goldId: `g${i}` })));
      assert.deepEqual(report.attempts[0].metrics.recall, { numerator: paths.length, denominator: paths.length, value: 1 });
      assert.deepEqual(report.attempts[0].metrics.precision, { numerator: paths.length, denominator: paths.length, value: 1 });
    }
    assert.equal(readFileSync(join(imported, "reviewer", "input.json"), "utf8"), reviewerBytes);
    assert.equal(/independent|descriptionGoldIds|sourceSHA256|goldLocations/.test(reviewerBytes), false);
    assert.equal(existsSync(join(f.repo, "PWNED")), false);
    assert.equal(existsSync(join(process.cwd(), "PWNED")), false);
  } finally { f.cleanup(); }
});


test("all product and gold boundaries reject unsafe, malformed and overlong location paths before output", () => {
  const f = fixture();
  try {
    if (f.evaluator.gold.status !== "ready") assert.fail();
    const manifestPath = join(f.root, "manifest.json"); const evaluatorPath = join(f.root, "gold.json"); const resultsPath = join(f.root, "results.json");
    writeFileSync(manifestPath, JSON.stringify(f.manifest));
    const invalidPaths = ["", "/absolute.ts", "../outside.ts", "a/../b.ts", "a/./b.ts", "a//b.ts", "a/", "C:/drive.ts", "C:drive.ts", "a:stream", "back\\slash.ts", "\\\\server\\share", "nul\0.ts", "tab\t.ts", "line\n.ts", "cr\r.ts", "del\u007f.ts", "control\u0085.ts", "bidi\u061c.ts", "bidi\u200e.ts", "bidi\u200f.ts", "bidi\u202a.ts", "bidi\u202b.ts", "bidi\u202c.ts", "bidi\u202d.ts", "bidi\u202e.ts", "bidi\u2066.ts", "bidi\u2067.ts", "bidi\u2068.ts", "bidi\u2069.ts", "\ud800", "\udc00", "a".repeat(2001), "😀".repeat(2001)];
    const captureCases = (path: string): { name: ProductResults["product"]["name"]; attempt: ProductResults["attempts"][number] }[] => [
        { name: "Needlefish", attempt: { id: "attempt-1", status: "completed", format: "needlefish-capture-v1", findings: [{ id: "f1", title: "Zero", whyItBreaks: "Zero divisor", file: path, side: "head", lineStart: 1, lineEnd: 1 }] } },
        { name: "Codex review", attempt: { id: "attempt-1", status: "completed", format: "codex-review-capture-v1", findings: [{ id: "f1", title: "Zero", body: "Zero divisor", code_location: { file: path, side: "head", start: 1, end: 1 } }] } },
        { name: "CodeRabbit", attempt: { id: "attempt-1", status: "completed", format: "coderabbit-capture-v1", findings: [{ id: "f1", body: "Zero divisor", path, side: "RIGHT", start_line: 1, line: 1 }] } },
    ];
    for (const path of invalidPaths) {
      for (const candidate of captureCases(path)) {
        const results = { ...f.results, product: { ...f.results.product, name: candidate.name }, attempts: [candidate.attempt] };
        assert.throws(() => parseProductResults(JSON.stringify(results)), /invalid_product_results|invalid_location/, `${candidate.name}: ${JSON.stringify(path)}`);
        if (path === "../outside.ts") {
          writeFileSync(resultsPath, JSON.stringify(results)); writeFileSync(evaluatorPath, JSON.stringify(f.evaluator));
          const output = join(f.root, `${candidate.name}-invalid.json`);
          assert.throws(() => scoreMain([manifestPath, evaluatorPath, resultsPath, output, "--repo", f.repo]), /invalid_location/);
          assert.equal(existsSync(output), false);
        }
      }
      const gold = { ...f.evaluator.gold, findings: [{ id: "g1", description: "Zero", location: { path, side: "head", start: 1, end: 1 } }] };
      assert.throws(() => parseEvaluator(JSON.stringify({ ...f.evaluator, gold })), /invalid_evaluator|invalid_location/, JSON.stringify(path));
    }
    const maxPath = "😀".repeat(2000);
    for (const candidate of captureCases(maxPath)) {
      const results = parseProductResults(JSON.stringify({ ...f.results, product: { ...f.results.product, name: candidate.name }, attempts: [candidate.attempt] }));
      const attempt = results.attempts[0];
      if (attempt.status !== "completed") assert.fail();
      assert.deepEqual(normalizeFindings(attempt)[0].location, { path: maxPath, side: "head", start: 1, end: 1 });
    }
    const gold = { ...f.evaluator.gold, findings: [{ id: "g1", description: "Zero", location: { path: maxPath, side: "head", start: 1, end: 1 } }] };
    const parsedGold = parseEvaluator(JSON.stringify({ ...f.evaluator, gold }));
    if (parsedGold.gold.status !== "ready") assert.fail();
    assert.equal(parsedGold.gold.findings[0].location.path, maxPath);
  } finally { f.cleanup(); }
});


test("gold line bounds preserve empty, LF, CRLF and Unicode source semantics on both sides", () => {
  const cases = [
    { base: "", head: "x", baseLines: 0, headLines: 1 },
    { base: "x", head: "", baseLines: 1, headLines: 0 },
    { base: "\n", head: "\n\n", baseLines: 1, headLines: 2 },
    { base: "one\ntwo", head: "one\ntwo\n", baseLines: 2, headLines: 2 },
    { base: "one\r\ntwo\r\n", head: "one\rtwo", baseLines: 2, headLines: 1 },
    { base: "中文😀\u2028next\u2029last", head: "中文😀\nnext\n", baseLines: 1, headLines: 2 },
  ];
  for (const content of cases) {
    const f = fixture(["value.ts"], content);
    try {
      f.results.attempts = [{ id: "attempt-1", status: "completed", format: "needlefish-capture-v1", findings: [] }];
      f.evaluator.attempts = [];
      if (content.baseLines > 0 && content.headLines > 0) {
        f.evaluator.gold = { status: "ready", provenance: "Synthetic distinct side lengths", findings: [
          { id: "base", description: "Base defect", location: { path: "value.ts", side: "base", start: content.baseLines, end: content.baseLines } },
          { id: "head", description: "Head defect", location: { path: "value.ts", side: "head", start: content.headLines, end: content.headLines } },
        ] };
        assert.equal(metrics(f).missed, 2);
        if (content.baseLines !== content.headLines) {
          const longer = Math.max(content.baseLines, content.headLines);
          f.evaluator.gold.findings.sort((a,b) => b.location.end - a.location.end);
          f.evaluator.gold.findings[1].location.end = longer;
          assert.throws(f.score, /gold_location_outside_snapshot/);
        }
      }
      for (const side of ["base", "head"] as const) {
        const lines = side === "base" ? content.baseLines : content.headLines;
        const gold = (end: number): Evaluator["gold"] => ({ status: "ready", provenance: "Synthetic line-boundary observation", findings: [{ id: "g1", description: "Synthetic defect", location: { path: "value.ts", side, start: end, end } }] });
        if (lines > 0) {
          f.evaluator.gold = gold(lines);
          assert.equal(metrics(f).missed, 1);
        }
        f.evaluator.gold = gold(lines + 1);
        assert.throws(f.score, /gold_location_outside_snapshot/, `${side}: ${JSON.stringify(content[side])}`);
      }
      f.evaluator.gold = { status: "ready", provenance: "Synthetic repeated valid locations", findings: Array.from({ length: 1000 }, (_,i) => ({ id: `g${i}`, description: "Synthetic defect", location: { path: "value.ts", side: content.headLines > 0 ? "head" : "base", start: 1, end: 1 } })) };
      assert.equal(metrics(f).missed, 1000);
    } finally { f.cleanup(); }
  }
});
