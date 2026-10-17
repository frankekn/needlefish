import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { commitAll, headSha, initRepo } from "../shared/codex-runner-test-fixtures.js";
import type { Bundle, Hotspot } from "../shared/schema.js";
import { collectLargeLiteralContext, changedLiteralSeeds, hotspotLiteralContext } from "./large-literal-context.js";
import { review } from "./review.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-large-context-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repo = initRepo(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  writeFileSync(path.join(repo, "old.ts"), "export const ceiling = 4;\n");
  writeFileSync(path.join(repo, "consumer.ts"), "use(ceiling);\n");
  writeFileSync(path.join(repo, "other.ts"), "export const separate = 5;\n");
  commitAll(repo, "base");
  const baseSha = headSha(repo);
  renameSync(path.join(repo, "old.ts"), path.join(repo, "new.ts"));
  writeFileSync(path.join(repo, "new.ts"), "export const ceiling = 6;\n");
  writeFileSync(path.join(repo, "other.ts"), "export const separate = 7;\n");
  commitAll(repo, "head");
  const head = headSha(repo);
  const bundle: Bundle = { repoPath: repo, baseSha, headSha: head, patch: git("diff", "-M", baseSha, head),
    patchStat: git("diff", "--stat", baseSha, head), changedFiles: [{ path: "new.ts", surface: "source" }, { path: "other.ts", surface: "source" }, { path: "old.ts", surface: "source" }],
    agentsMd: "(none)", prMeta: null, deep: true, focus: null };
  return { root, repo, git, bundle, snapshot: { repoPath: repo, expectedBaseSha: baseSha, expectedHeadSha: head } };
}

const hotspot = (file: string): Hotspot => ({ name: file, files: [file], why: "changed", risk: "high", edges: [] });

test("captured diff keeps BASE old and HEAD new anchors, including rename ownership", async (t) => {
  const f = fixture(t);
  const bundle = { ...f.bundle, changedFiles: [{ path: "new.ts", surface: "source" as const }], patch: [
    "diff --git a/old.ts b/new.ts", "similarity index 70%", "rename from old.ts", "rename to new.ts", "--- a/old.ts", "+++ b/new.ts", "@@ -1 +1 @@",
    "-export const prior = 4;", "+export const ceiling = 6;", "",
  ].join("\n") };
  const selected = changedLiteralSeeds(bundle, f.snapshot);
  assert.deepEqual(selected.seeds, [
    { revision: f.bundle.baseSha, path: "old.ts", line: 1, identifier: "prior" },
    { revision: f.bundle.headSha, path: "new.ts", line: 1, identifier: "ceiling" },
  ]);
  assert.deepEqual(selected.anchorOwners, [
    { revision: f.bundle.baseSha, path: "old.ts", changedPath: "new.ts" },
    { revision: f.bundle.headSha, path: "new.ts", changedPath: "new.ts" },
  ]);
  const collected = await collectLargeLiteralContext({ bundle, snapshot: f.snapshot, abortSignal: new AbortController().signal });
  assert.equal(collected.collection.status, "partial");
  assert.deepEqual(collected.collection.gaps, ["anchor_unverified"]);
  assert.ok(collected.collection.candidates.some((candidate) => candidate.path === "consumer.ts"));
  assert.equal(hotspotLiteralContext(collected, hotspot("new.ts")).candidates.length, collected.collection.candidates.length);
  assert.deepEqual(hotspotLiteralContext(collected, hotspot("other.ts")).candidates, []);
});

test("verified rename candidates keep old path seeds in the new-path hotspot", async (t) => {
  const f = fixture(t);
  const bundle = { ...f.bundle, changedFiles: [{ path: "new.ts", surface: "source" as const }], patch: [
    "diff --git a/old.ts b/new.ts", "--- a/old.ts", "+++ b/new.ts", "@@ -1 +1 @@",
    "-export const ceiling = 4;", "+export const ceiling = 6;", "",
  ].join("\n") };
  const collected = await collectLargeLiteralContext({ bundle, snapshot: f.snapshot, abortSignal: new AbortController().signal });
  assert.equal(collected.collection.status, "complete_literal_search");
  const routed = hotspotLiteralContext(collected, hotspot("new.ts"));
  assert.deepEqual([...new Set(routed.candidates.map((candidate) => candidate.seed.path))], ["old.ts", "new.ts"]);
  assert.ok(routed.candidates.some((candidate) => candidate.seed.path === "old.ts" && candidate.path === "consumer.ts"));
  assert.ok(routed.candidates.some((candidate) => candidate.seed.path === "new.ts" && candidate.path === "consumer.ts"));
  assert.deepEqual(hotspotLiteralContext(collected, hotspot("other.ts")).candidates, []);
});

test("actual fixed Git source retains literal provenance and ignores mutable refs and working files", async (t) => {
  const f = fixture(t);
  const collect = () => collectLargeLiteralContext({ bundle: f.bundle, snapshot: f.snapshot, abortSignal: new AbortController().signal });
  const before = await collect();
  writeFileSync(path.join(f.repo, "consumer.ts"), "AMBIENT_MUTATION\n");
  writeFileSync(path.join(f.repo, "untracked.ts"), "ceiling\n");
  f.git("update-ref", "refs/heads/moving", f.bundle.baseSha);
  const after = await collect();
  assert.deepEqual(after, before);
  assert.equal(after.collection.status, "complete_literal_search");
  assert.ok(after.collection.candidates.some((candidate) => candidate.path === "consumer.ts" && candidate.snippet === "use(ceiling);"));
  const own = hotspotLiteralContext(after, hotspot("new.ts"));
  assert.ok(own.candidates.some((candidate) => candidate.path === "consumer.ts"));
  assert.ok(own.candidates.every((candidate) => candidate.seed.path === "new.ts"));
  assert.equal(own.semanticStatus, "unknown");
  assert.deepEqual(hotspotLiteralContext(after, hotspot("unrelated.ts")).candidates, []);
  assert.ok(hotspotLiteralContext(after, hotspot("other.ts")).candidates.every((candidate) => candidate.seed.identifier === "separate"));
});

test("seed extraction is capped, interleaved and exposes unsupported paths and empty patches", (t) => {
  const f = fixture(t);
  const capped = changedLiteralSeeds({ ...f.bundle, patch: "--- a/old.ts\n+++ b/new.ts\n@@ -1 +1 @@\n-a b c d e f g h i j\n+k l m n o p q r s t\n" }, f.snapshot);
  assert.deepEqual(capped.seeds.map((seed) => seed.identifier), ["a", "k", "b", "l", "c", "m", "d", "n"]);
  assert.deepEqual(capped.gaps, ["seed_count_cap"]);
  const empty = changedLiteralSeeds({ ...f.bundle, patch: "" }, f.snapshot);
  assert.deepEqual(empty, { seeds: [], gaps: ["no_changed_anchor_seed"], anchorOwners: [] });
  const unsupported = changedLiteralSeeds({ ...f.bundle, patch: '--- "a/\\303\\251.ts"\n+++ "b/\\303\\251.ts"\n@@ -1 +1 @@\n-a\n+b\n' }, f.snapshot);
  assert.deepEqual(unsupported.gaps, ["unsupported_diff_path", "no_changed_anchor_seed"]);
});

test("missing identity, partial blobs, shared deadline and pre-abort never become complete empty search", async (t) => {
  const f = fixture(t);
  const collect = (snapshot = f.snapshot, extra = {}) => collectLargeLiteralContext({ bundle: f.bundle, snapshot, abortSignal: new AbortController().signal, ...extra });
  assert.deepEqual((await collect({ ...f.snapshot, expectedBaseSha: "WORKING" })).collection.gaps, ["unsupported_snapshot"]);
  assert.deepEqual((await collect(f.snapshot, { reviewDeadlineMs: performance.now() - 1 })).collection.gaps, ["deadline"]);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual((await collect(f.snapshot, { abortSignal: controller.signal })).collection.gaps, ["aborted"]);
  writeFileSync(path.join(f.repo, "huge.ts"), "ceiling".repeat(700)); commitAll(f.repo, "large blob");
  const partial = await collect({ ...f.snapshot, expectedHeadSha: headSha(f.repo) });
  assert.equal(partial.collection.status, "partial");
  assert.ok(partial.collection.gaps.includes("blob_bytes_cap"));
  assert.ok(partial.collection.candidates.some((candidate) => candidate.path === "consumer.ts"));
});

for (const mode of ["committed", "working", "unborn"] as const) {
  test(`large review routes fixed ${mode} snapshot candidates only to related deep hotspots`, async (t) => {
    const f = fixture(t);
    let bundle = f.bundle;
    if (mode === "working") bundle = { ...bundle, headSha: "WORKING" };
    if (mode === "unborn") {
      const repo = path.join(f.root, "unborn");
      execFileSync("git", ["init", "-q", repo]);
      bundle = { ...bundle, repoPath: repo, baseSha: "EMPTY", headSha: "WORKING", patch: "diff --git a/new.ts b/new.ts\nnew file mode 100644\n--- /dev/null\n+++ b/new.ts\n@@ -0,0 +1 @@\n+export const ceiling = 6;\n", changedFiles: [{ path: "new.ts", surface: "source" }] };
    }
    const prompts = path.join(f.root, "prompts.jsonl");
    const bin = path.join(f.root, "codex.cjs");
    writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'); let input='';
process.stdin.on('data',chunk=>input+=chunk);
process.stdin.on('end',()=>{
 const out=process.argv[process.argv.indexOf('--output-last-message')+1];
 const stage=input.includes('review-MAP pass')?'map':input.includes('doing a DEEP review')?'deep':input.includes('adversarial critic')?'critic':'small';
 fs.appendFileSync(${JSON.stringify(prompts)},JSON.stringify({stage,input})+'\\n');
 if(stage==='map') { fs.writeFileSync(${JSON.stringify(path.join(bundle.repoPath, "new.ts"))},'AMBIENT_MUTATION'); fs.writeFileSync(out,JSON.stringify({summary:'mapped',hotspots:[{name:'main',files:['new.ts'],why:'changed',risk:'high',edges:[]}]})); }
 else fs.writeFileSync(out,JSON.stringify({summary:'clean',findings:[],checked:['FILES inspected=[new.ts]'],residual_risks:[]}));
});
`);
    chmodSync(bin, 0o755);
    const previous = { CODEX_BIN: process.env.CODEX_BIN, NEEDLEFISH_NO_RETRY: process.env.NEEDLEFISH_NO_RETRY };
    t.after(() => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; });
    Object.assign(process.env, { CODEX_BIN: bin, NEEDLEFISH_NO_RETRY: "1" });
    const result = await review(bundle);
    assert.equal(result.verdict, "pass");
    assert.match(result.coverage ?? "", mode === "unborn" ? /^1\/1 changed files/ : /^3\/3 changed files/);
    const raw: unknown[] = readFileSync(prompts, "utf8").trim().split("\n").map((row: string) => JSON.parse(row));
    const rows = raw.map((row) => { assert.ok(typeof row === "object" && row !== null && "stage" in row && "input" in row && typeof row.input === "string"); return { stage: row.stage, input: row.input }; });
    assert.deepEqual(rows.map((row) => row.stage).sort(), mode === "unborn" ? ["critic", "deep", "map"] : ["critic", "deep", "deep", "map"]);
    assert.ok(rows.filter((row) => row.stage !== "deep").every((row) => !row.input.includes('"literalContext"')));
    const deep = rows.find((row) => row.stage === "deep" && row.input.includes('"name": "main"'));
    assert.ok(deep);
    assert.match(deep.input, /"relationship": "unverified_literal"/);
    assert.match(deep.input, /"snippet": "export const ceiling = 6;"/);
    assert.doesNotMatch(deep.input, /AMBIENT_MUTATION|unsupported_snapshot/);
    const payload = deep.input.slice(deep.input.indexOf('"literalContext"'));
    assert.doesNotMatch(payload, /"identifier": "separate"/);
    if (mode === "committed") assert.match(deep.input, new RegExp(bundle.headSha));
    else assert.match(deep.input, /"revision": "[a-f0-9]{40}"/);
  });
}
