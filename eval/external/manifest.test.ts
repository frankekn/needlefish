import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { evaluatorMetadata, importManifest, parseManifest, sha256, type ExternalManifest } from "./manifest.js";
import { main } from "./import.js";

const samples = fileURLToPath(new URL("./samples/", import.meta.url));
const clean = () => parseManifest(readFileSync(join(samples, "swrbench-pytest-3248.json"), "utf8"));
const positive = () => parseManifest(readFileSync(join(samples, "martian-calcom-8087.json"), "utf8"));
function fixture(headContent = "export const value = 2;\n") {
  const root = mkdtempSync(join(tmpdir(), "needlefish-external-"));
  const repo = join(root, "repo");
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trimEnd();
  execFileSync("git", ["init", "-q", repo]);
  run("config", "user.name", "Fixture");
  run("config", "user.email", "fixture@example.invalid");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "example.ts"), "export const value = 1;\n");
  run("add", "."); run("commit", "-qm", "base");
  const base = run("rev-parse", "HEAD");
  const baseTree = run("rev-parse", "HEAD^{tree}");
  writeFileSync(join(repo, "example.ts"), headContent);
  run("commit", "-qam", "head");
  const head = run("rev-parse", "HEAD");
  const diff = execFileSync("git", ["diff", "--full-index", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--no-color", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", base, head, "--"], { cwd: repo, encoding: "utf8" });
  const manifest: ExternalManifest = {
    ...clean(),
    snapshot: { kind: "frozen", sourceBaseSHA: base, reviewBaseSHA: base, reviewHeadSHA: head, observedFinalHeadSHA: "f".repeat(40), mergeBaseSHA: base, commitSHAs: [head], baseTreeSHA: baseTree, headTreeSHA: run("rev-parse", "HEAD^{tree}"), diffSHA256: sha256(diff) },
    reviewText: { kind: "frozen", title: "Change a value", description: "Update the exported value.", policy: "Review correctness.", titleSHA256: sha256("Change a value"), descriptionSHA256: sha256("Update the exported value."), policySHA256: sha256("Review correctness.") },
  };
  return { root, repo, run, manifest, base, head, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("real samples retain excluded snapshots, original dataset head, provenance scope, and unscorable gold", () => {
  const m = clean();
  assert.equal(m.snapshot.reviewBaseSHA, "053fc118b7af3b77c42daddd6ceacd13394cf64a");
  assert.equal(m.snapshot.reviewHeadSHA, "6e14585ca20d27db81f122d2c3a76135e4192fc4");
  assert.equal(m.snapshot.observedFinalHeadSHA, "147b43f83216c612ab0122c8a3961895c4222abe");
  assert.notEqual(m.snapshot.sourceBaseSHA, m.snapshot.reviewBaseSHA);
  assert.equal(m.source.sourceBytes.scope, "slice");
  assert.deepEqual(importManifest(m), { status: "excluded", reasons: ["local_code_objects_not_imported", "tree_and_diff_hashes_unknown", "upstream_code_license_unknown"] });
  const p = positive();
  assert.equal(p.source.canonicalRepo, "calcom/cal.diy");
  assert.deepEqual(evaluatorMetadata(p, importManifest(p)).scoringReasons, ["common_rubric_not_frozen", "gold_locations_missing"]);
  assert.equal(evaluatorMetadata(m, importManifest(m)).unmatchedFindingPolicy, "requires_blind_adjudication_not_automatic_false_positive");
});

test("boundary rejects raw dataset fields, invalid hashes, contradictory labels and unidentified slices", () => {
  for (const candidate of [
    { ...clean(), pr_timeline: ["GOLD-LEAK"] },
    { ...clean(), source: { ...clean().source, comments: "GOLD-LEAK" } },
    { ...clean(), evaluator: { ...clean().evaluator, goldCount: 2 } },
    { ...clean(), source: { ...clean().source, datasetRevision: "main" } },
    { ...clean(), source: { ...clean().source, sourceBytes: { ...clean().source.sourceBytes, rangeStart: null } } },
  ]) assert.throws(() => parseManifest(JSON.stringify(candidate)), /invalid_manifest|clean_with_gold|invalid_source_byte_scope/);
});

test("local source export contains exact code, patch, hunk ranges and no evaluator metadata", () => {
  const f = fixture();
  try {
    f.manifest.evaluator.provenance = "GOLD-LEAK-comments-fixes-other-findings";
    const result = importManifest(f.manifest, f.repo);
    assert.equal(result.status, "source-ready");
    if (result.status !== "source-ready") assert.fail(JSON.stringify(result));
    assert.deepEqual(result.reviewer.headFiles, [{ path: "example.ts", mode: "100644", content: "export const value = 2;\n" }]);
    assert.deepEqual(result.reviewer.baseFiles, [{ path: "example.ts", mode: "100644", content: "export const value = 1;\n" }]);
    assert.deepEqual(result.reviewer.lineMap, [{ path: "example.ts", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }]);
    assert.equal(result.reviewer.snapshot.headSHA, f.head);
    assert.match(result.reviewer.diff, /-export const value = 1;\n\+export const value = 2;/);
    assert.deepEqual(Object.keys(result.reviewer).sort(), ["baseFiles", "description", "diff", "headFiles", "lineMap", "policy", "schemaVersion", "snapshot", "title"]);
    assert.equal(/GOLD-LEAK|swrbench|pytest|goldCount|clean|observedFinalHead|sourceURL/.test(JSON.stringify(result.reviewer)), false);
    const before = JSON.stringify(result.reviewer);
    f.manifest.evaluator = { label: "positive", goldCount: 12, goldLocations: "missing", provenance: "DIFFERENT-ANSWER" };
    const changed = importManifest(f.manifest, f.repo);
    assert.equal(changed.status, "source-ready");
    if (changed.status === "source-ready") assert.equal(JSON.stringify(changed.reviewer), before);
    const input = join(f.root, "manifest.json"); writeFileSync(input, JSON.stringify(f.manifest));
    const output = join(f.root, "output"); main([input, output, "--repo", f.repo]);
    assert.equal(readFileSync(join(output, "reviewer", "input.json"), "utf8"), `${JSON.stringify(result.reviewer, null, 2)}\n`);
    assert.equal(JSON.parse(readFileSync(join(output, "evaluator.json"), "utf8")).evaluator.provenance, "DIFFERENT-ANSWER");
    assert.throws(() => main([input, output, "--repo", f.repo]), /EEXIST/);
  } finally { f.cleanup(); }
});

test("missing objects, wrong parent series, final-head substitution, tree and truncated-patch hashes fail closed", () => {
  const f = fixture();
  try {
    if (f.manifest.snapshot.kind !== "frozen" || f.manifest.reviewText.kind !== "frozen") assert.fail();
    assert.deepEqual(importManifest(f.manifest), { status: "excluded", reasons: ["local_objects_not_checked"] });
    const original = structuredClone(f.manifest);
    const cases = [
      { reviewHeadSHA: "e".repeat(40) }, { reviewBaseSHA: f.head },
      { reviewHeadSHA: f.manifest.snapshot.observedFinalHeadSHA },
      { baseTreeSHA: "e".repeat(40) }, { mergeBaseSHA: f.head },
      { diffSHA256: sha256("diff --git a/example.ts b/example.ts\n") },
    ];
    for (const patch of cases) {
      const candidate = parseManifest(JSON.stringify({ ...original, snapshot: { ...original.snapshot, ...patch } }));
      assert.equal(importManifest(candidate, f.repo).status, "excluded", JSON.stringify(patch));
    }
    f.manifest.reviewText.title += " changed";
    assert.deepEqual(importManifest(f.manifest, f.repo), { status: "excluded", reasons: ["title_hash_mismatch"] });
    const input = join(f.root, "excluded.json"); writeFileSync(input, JSON.stringify(clean()));
    const output = join(f.root, "excluded"); main([input, output]);
    assert.equal(existsSync(join(output, "reviewer")), false);
    assert.equal(JSON.parse(readFileSync(join(output, "evaluator.json"), "utf8")).importStatus, "excluded");
  } finally { f.cleanup(); }
});

test("nonlinear merge commits are rejected instead of changing the review base", () => {
  const f = fixture();
  try {
    f.run("checkout", "-qb", "side", f.base);
    writeFileSync(join(f.repo, "side.ts"), "side\n"); f.run("add", "."); f.run("commit", "-qm", "side");
    f.run("checkout", "-q", "-"); f.run("merge", "--no-ff", "-qm", "merge", "side");
    if (f.manifest.snapshot.kind !== "frozen") assert.fail();
    const merged = f.run("rev-parse", "HEAD");
    f.manifest.snapshot.reviewHeadSHA = merged;
    f.manifest.snapshot.commitSHAs = [f.head, merged];
    assert.deepEqual(importManifest(f.manifest, f.repo), { status: "excluded", reasons: ["unexpected_parent_dag"] });
  } finally { f.cleanup(); }
});

test("binary source is excluded even when the declared diff hash matches", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "binary.dat"), Buffer.from([0, 1, 2]));
    f.run("add", "."); f.run("commit", "-qm", "binary");
    if (f.manifest.snapshot.kind !== "frozen") assert.fail();
    const snapshot = f.manifest.snapshot;
    snapshot.commitSHAs.push(f.run("rev-parse", "HEAD")); snapshot.reviewHeadSHA = f.run("rev-parse", "HEAD"); snapshot.headTreeSHA = f.run("rev-parse", "HEAD^{tree}");
    assert.deepEqual(importManifest(f.manifest, f.repo), { status: "excluded", reasons: ["unsupported_binary"] });
  } finally { f.cleanup(); }
});


test("partial clones fail before object operations can fetch", () => {
  const f = fixture();
  try {
    f.run("config", "remote.origin.promisor", "true");
    f.run("config", "remote.origin.url", "https://example.invalid/never-fetch");
    assert.deepEqual(importManifest(f.manifest, f.repo), { status: "excluded", reasons: ["unsupported_partial_clone"] });
  } finally { f.cleanup(); }
});


test("local diff configuration and attributes cannot change source bytes or the canonical patch", () => {
  const f = fixture();
  try {
    const before = importManifest(f.manifest, f.repo);
    assert.equal(before.status, "source-ready");
    f.run("config", "diff.interHunkContext", "100");
    f.run("config", "diff.outputIndicatorNew", "!");
    f.run("config", "diff.noprefix", "true");
    f.run("config", "diff.mnemonicPrefix", "true");
    f.run("config", "diff.algorithm", "histogram");
    f.run("config", "diff.external", "/not-a-real-tool");
    writeFileSync(join(f.repo, ".git", "info", "attributes"), "*.ts -diff\n");
    assert.deepEqual(importManifest(f.manifest, f.repo), before);
  } finally { f.cleanup(); }
});

test("signed commit metadata never invokes the target's configured GPG program", () => {
  const f = fixture();
  try {
    if (f.manifest.snapshot.kind !== "frozen") assert.fail();
    const marker = join(f.root, "gpg-executed");
    const program = join(f.root, "fake-gpg");
    writeFileSync(program, `#!/bin/sh\n: > "${marker}"\nexit 1\n`, { mode: 0o755 });
    f.run("config", "log.showSignature", "true"); f.run("config", "gpg.program", program);
    const raw = `tree ${f.manifest.snapshot.headTreeSHA}\nparent ${f.base}\nauthor Fixture <fixture@example.invalid> 1000000000 +0000\ncommitter Fixture <fixture@example.invalid> 1000000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`;
    const head = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: f.repo, input: raw, encoding: "utf8" }).trim();
    f.manifest.snapshot.reviewHeadSHA = head; f.manifest.snapshot.commitSHAs = [head];
    const result = importManifest(f.manifest, f.repo);
    assert.equal(result.status, "source-ready");
    assert.equal(existsSync(marker), false);
    if (result.status === "source-ready") assert.equal(result.reviewer.snapshot.headSHA, head);
  } finally { f.cleanup(); }
});

test("UTF-8 byte order marks remain part of exported source bytes", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, "bom.ts"), "\ufeffexport const bom = 1;\n");
    f.run("add", "."); f.run("commit", "-qm", "bom");
    if (f.manifest.snapshot.kind !== "frozen") assert.fail();
    const snapshot = f.manifest.snapshot;
    snapshot.commitSHAs.push(f.run("rev-parse", "HEAD")); snapshot.reviewHeadSHA = f.run("rev-parse", "HEAD"); snapshot.headTreeSHA = f.run("rev-parse", "HEAD^{tree}");
    const patch = execFileSync("git", ["diff", "--full-index", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--no-color", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", f.base, snapshot.reviewHeadSHA, "--"], { cwd: f.repo });
    snapshot.diffSHA256 = sha256(patch);
    const result = importManifest(f.manifest, f.repo);
    assert.equal(result.status, "source-ready");
    if (result.status === "source-ready") assert.deepEqual(result.reviewer.headFiles.find((file) => file.path === "bom.ts"), { path: "bom.ts", mode: "100644", content: "\ufeffexport const bom = 1;\n" });
  } finally { f.cleanup(); }
});


test("copied dataset notices match the declared license hashes", () => {
  const notices = fileURLToPath(new URL("./licenses/", import.meta.url));
  assert.equal(sha256(readFileSync(join(notices, "martian-MIT.txt"))), positive().source.datasetLicense.noticeSHA256);
  assert.equal(sha256(readFileSync(join(notices, "swr-MIT.txt"))), clean().source.datasetLicense.noticeSHA256);
});


test("CLI bounds manifest bytes before decode and rejects directories and FIFOs", () => {
  const root = mkdtempSync(join(tmpdir(), "needlefish-external-boundary-"));
  try {
    const input = join(root, "input.json");
    const valid = JSON.stringify(clean());
    writeFileSync(input, valid.padEnd(250_000, " "));
    const accepted = join(root, "accepted"); main([input, accepted]);
    assert.equal(JSON.parse(readFileSync(join(accepted, "evaluator.json"), "utf8")).importStatus, "excluded");
    writeFileSync(input, valid.padEnd(250_001, " "));
    const rejected = join(root, "rejected");
    assert.throws(() => main([input, rejected]), /manifest_too_large/);
    assert.equal(existsSync(rejected), false);
    assert.throws(() => main([root, rejected]), /manifest_not_regular_file/);
    writeFileSync(input, Buffer.from([0xff]));
    assert.throws(() => main([input, rejected]), /encoded data|UTF-8/);
    if (process.platform !== "win32") {
      const fifo = join(root, "input.fifo"); execFileSync("mkfifo", [fifo]);
      assert.throws(() => main([fifo, rejected]), /manifest_not_regular_file/);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test("unrelated objects sharing a blob prefix cannot change frozen diff bytes", () => {
  const f = fixture("export const value = 11740;\n");
  try {
    const before = importManifest(f.manifest, f.repo);
    assert.equal(before.status, "source-ready");
    const unrelated = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: "export const value = 18354;\n", encoding: "utf8" }).trim();
    assert.equal(unrelated, "44b7bbdedfc8ef441f25ac39445696f872cc456b");
    const after = importManifest(f.manifest, f.repo);
    assert.deepEqual(after, before);
    if (after.status === "source-ready") assert.match(after.reviewer.diff, /^index [a-f0-9]{40}\.\.44b7bbd77d9e79118961db2677e73a0eef12efa0 100644$/m);
  } finally { f.cleanup(); }
});
