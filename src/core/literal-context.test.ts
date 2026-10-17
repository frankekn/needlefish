import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { collectLiteralContext, LITERAL_CONTEXT_CAPS, type LiteralContextSeed } from "./literal-context.js";

function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-literal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (args: string[], input?: Buffer | string): Buffer => {
    const result = spawnSync("git", ["--no-replace-objects", ...args], { cwd: root, input, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, result.stderr?.toString());
    return result.stdout;
  };
  git(["init", "-q"]);
  const snapshot = (files: Record<string, string | Buffer>, extras: { name: Buffer; mode: string; oid: string }[] = []): string => {
    const rows: { name: Buffer; mode: string; oid: string }[] = Object.entries(files).map(([name, content]) => ({ name: Buffer.from(name), mode: "100644", oid: git(["hash-object", "-w", "--stdin"], content).toString().trim() }));
    rows.push(...extras);
    const tree = git(["mktree", "-z"], Buffer.concat(rows.map((row) => Buffer.concat([
      Buffer.from(`${row.mode} ${row.mode === "160000" ? "commit" : "blob"} ${row.oid}\t`), row.name, Buffer.from([0]),
    ])))).toString().trim();
    return git(["hash-object", "-t", "commit", "-w", "--stdin"], `tree ${tree}\nauthor Test <test@example.invalid> 1700000000 +0000\ncommitter Test <test@example.invalid> 1700000000 +0000\n\nfixed\n`).toString().trim();
  };
  const collect = (base: string, head: string, seeds: LiteralContextSeed[], extra = {}) => collectLiteralContext({
    snapshot: { repoPath: root, expectedBaseSha: base, expectedHeadSha: head }, seeds, ...extra,
  });
  return { root, git, snapshot, collect };
}

const seed = (revision: string, file = "producer.ts", identifier = "permit", line = 1): LiteralContextSeed => ({ revision, path: file, line, identifier });

function locations(result: Awaited<ReturnType<typeof collectLiteralContext>>) {
  return result.candidates.map(({ path, line }) => `${path}:${line}`);
}

test("fixed objects keep producer and consumer candidates independent of CWD, mutable files, refs and replacements", async (t) => {
  const f = fixture(t);
  const base = f.snapshot({ "producer.ts": "export const permit = true;\n", "consumer.ts": "import { permit } from './producer';\nuse(permit);\n" });
  const head = f.snapshot({ "producer.ts": "export const permit = false;\n", "consumer.ts": "import { permit } from './producer';\nuse(permit);\n" });
  const expected = await f.collect(base, head, [seed(head)]);
  assert.equal(expected.status, "complete_literal_search");
  assert.deepEqual(locations(expected), ["consumer.ts:1", "consumer.ts:2", "producer.ts:1"]);
  const consumer = expected.candidates[1];
  assert.deepEqual(consumer, { seed: seed(head), revision: head, path: "consumer.ts", line: 2,
    blobOid: f.git(["rev-parse", `${head}:consumer.ts`]).toString().trim(),
    contentSha256: createHash("sha256").update("import { permit } from './producer';\nuse(permit);\n").digest("hex"),
    snippet: "use(permit);", snippetTruncated: false, relationship: "unverified_literal", semanticStatus: "unknown" });
  writeFileSync(path.join(f.root, "consumer.ts"), "mutable permit malicious\n");
  writeFileSync(path.join(f.root, "untracked.ts"), "permit\n");
  const other = f.snapshot({ "unrelated.ts": "no candidates\n" });
  f.git(["update-ref", "refs/heads/moving", other]);
  f.git(["symbolic-ref", "HEAD", "refs/heads/moving"]);
  f.git(["replace", head, other]);
  const previous = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.deepEqual(await f.collect(base, head, [seed(head)]), expected);
  } finally { process.chdir(previous); }
});

test("BASE old and HEAD new identifiers retain distinct provenance across renames", async (t) => {
  const f = fixture(t);
  const base = f.snapshot({ "old.ts": "export const limit = 4;\n", "consumer.ts": "use(limit);\n" });
  const head = f.snapshot({ "new.ts": "export const ceiling = 4;\n", "consumer.ts": "use(ceiling);\n" });
  const result = await f.collect(base, head, [seed(base, "old.ts", "limit"), seed(head, "new.ts", "ceiling")]);
  assert.equal(result.status, "complete_literal_search");
  assert.deepEqual(result.candidates.map((value) => [value.revision, value.path, value.seed.identifier]), [
    [base, "consumer.ts", "limit"], [base, "old.ts", "limit"], [head, "consumer.ts", "ceiling"], [head, "new.ts", "ceiling"],
  ]);
});

test("consumer-only seeds find unchanged producer but alias, dynamic and same-name hits stay unknown", async (t) => {
  const f = fixture(t);
  const base = f.snapshot({ "producer.ts": "export const permit = true;\n", "consumer.ts": "use(permit);\n" });
  const head = f.snapshot({ "producer.ts": "export const permit = true;\n", "consumer.ts": "deny(permit);\n",
    "alias.ts": "import { permit as ok } from './producer';\nuse(ok);\n",
    "dynamic.ts": "registry[['per', 'mit'].join('')]();\n", "label.ts": "const label = 'permit';\n" });
  const result = await f.collect(base, head, [seed(head, "consumer.ts")]);
  assert.equal(result.status, "complete_literal_search");
  assert.deepEqual(locations(result), ["alias.ts:1", "consumer.ts:1", "label.ts:1", "producer.ts:1"]);
  assert.equal(result.semanticStatus, "unknown");
  assert.ok(result.candidates.every((value) => value.relationship === "unverified_literal" && value.semanticStatus === "unknown"));
});

for (const invalid of ["WORKING", "HEAD", "--help", "A".repeat(40), "a".repeat(39)]) {
  test(`non-fixed snapshot ${invalid} returns unsupported`, async (t) => {
    const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
    const result = await f.collect(invalid, head, [seed(head)]);
    assert.deepEqual([result.status, result.gaps, result.candidates], ["unknown", ["unsupported_snapshot"], []]);
  });
}

for (const file of ["../outside", "a/../b", "a\0b", "/absolute", "a\\b", "C:drive", "./producer.ts"]) {
  test(`seed path ${JSON.stringify(file)} is rejected before Git lookup`, async (t) => {
    const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
    const result = await f.collect(head, head, [seed(head, file)]);
    assert.deepEqual([result.status, result.gaps], ["unknown", ["invalid_seed"]]);
  });
}

test("option-like and pathspec-like filenames remain literal; identifiers cannot be options", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "--help.ts": "permit\n", ":(glob)*.ts": "permit\n", "other.ts": "none\n" });
  const result = await f.collect(head, head, [seed(head, "--help.ts"), seed(head, ":(glob)*.ts")]);
  assert.equal(result.status, "complete_literal_search");
  assert.deepEqual([...new Set(locations(result))], ["--help.ts:1", ":(glob)*.ts:1"]);
  assert.deepEqual((await f.collect(head, head, [seed(head, "--help.ts", "--help")])).gaps, ["invalid_seed"]);
});

test("seed line, identifier, revision and missing anchor must agree with fixed blob", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\nno token\n" });
  for (const value of [seed(head, "missing.ts"), seed(head, "producer.ts", "permit", 2), seed(head, "producer.ts", "absent")]) {
    const result = await f.collect(head, head, [value]);
    assert.equal(result.status, "unknown"); assert.equal(result.candidates.length, 0);
    assert.ok(result.gaps.includes(value.path === "missing.ts" ? "anchor_missing" : "anchor_unverified"));
  }
  assert.deepEqual((await f.collect(head, head, [seed("f".repeat(40))])).gaps, ["invalid_seed"]);
  assert.deepEqual((await f.collect(head, head, Array.from({ length: 9 }, () => seed(head)))).gaps, ["invalid_seed"]);
  assert.deepEqual((await f.collect(head, head, [seed(head, "producer.ts", "x".repeat(65))])).gaps, ["invalid_seed"]);
});

test("binary, symlink, gitlink and malformed UTF-8 blobs make collection partial", async (t) => {
  const f = fixture(t); const base = f.snapshot({ "producer.ts": "permit\n" });
  const link = f.git(["hash-object", "-w", "--stdin"], "producer.ts").toString().trim();
  const head = f.snapshot({ "producer.ts": "permit\n", "binary": Buffer.from("permit\0hidden"), "invalid": Buffer.from([0xff, 112, 101, 114, 109, 105, 116]) }, [
    { name: Buffer.from("link"), mode: "120000", oid: link }, { name: Buffer.from("submodule"), mode: "160000", oid: base },
  ]);
  const result = await f.collect(base, head, [seed(head)]);
  assert.equal(result.status, "partial");
  assert.deepEqual(new Set(result.gaps), new Set(["binary_blob", "invalid_utf8", "unsupported_entry"]));
  assert.deepEqual(locations(result), ["producer.ts:1"]);
});

test("malformed UTF-8 Git path is unknown without filesystem decoding or lossy candidates", async (t) => {
  const f = fixture(t); const oid = f.git(["hash-object", "-w", "--stdin"], "permit\n").toString().trim();
  const head = f.snapshot({ "producer.ts": "permit\n" }, [{ name: Buffer.from([0xff]), mode: "100644", oid }]);
  const result = await f.collect(head, head, [seed(head)]);
  assert.deepEqual([result.status, result.gaps, result.candidates], ["unknown", ["invalid_utf8"], []]);
});

test("valid multibyte, replacement character and BOM bytes roundtrip without corruption", async (t) => {
  const f = fixture(t); const text = "\uFEFFpermit '漢🙂�';\n";
  const head = f.snapshot({ "producer.ts": text });
  const result = await f.collect(head, head, [seed(head)]);
  assert.equal(result.status, "complete_literal_search");
  assert.equal(result.candidates[0].snippet, text.slice(0, -1));
  assert.equal(result.candidates[0].contentSha256, createHash("sha256").update(text).digest("hex"));
});

test("missing commit and missing blob produce explicit unknown gaps", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
  const missing = await f.collect("f".repeat(40), head, [seed(head)]);
  assert.deepEqual([missing.status, missing.gaps], ["unknown", ["git_read_failed"]]);
  const oid = f.git(["rev-parse", `${head}:producer.ts`]).toString().trim();
  rmSync(path.join(f.root, ".git", "objects", oid.slice(0, 2), oid.slice(2)));
  const result = await f.collect(head, head, [seed(head)]);
  assert.equal(result.status, "unknown"); assert.ok(result.gaps.includes("git_read_failed") || result.gaps.includes("malformed_tree"));
});

test("blob read cap preserves partial candidates instead of empty pass", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n", "large": "permit".repeat(700) });
  const result = await f.collect(head, head, [seed(head)]);
  assert.equal(result.status, "partial"); assert.deepEqual(result.gaps, ["blob_bytes_cap"]);
  assert.deepEqual(locations(result), ["producer.ts:1"]);
});

test("total read bytes and file count have independent visible caps", async (t) => {
  const f = fixture(t);
  const large = f.snapshot({ "producer.ts": "permit\n", ...Object.fromEntries(Array.from({ length: 5 }, (_, at) => [`f${at}`, `${at}${"x".repeat(4000)}`])) });
  const bytes = await f.collect(large, large, [seed(large)]);
  assert.equal(bytes.status, "partial"); assert.ok(bytes.gaps.includes("scan_bytes_cap"));
  assert.ok(bytes.scannedBytes <= LITERAL_CONTEXT_CAPS.scannedBytes);
  const many = f.snapshot({ "producer.ts": "permit\n", ...Object.fromEntries(Array.from({ length: 129 }, (_, at) => [`f${String(at).padStart(3, "0")}`, "no identifiers\n"])) });
  const files = await f.collect(many, many, [seed(many)]);
  assert.equal(files.status, "partial"); assert.ok(files.gaps.includes("file_count_cap"));
  assert.equal(files.scannedFiles, 128);
});

test("tree output cap is unknown rather than silent no-match", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n", ...Object.fromEntries(Array.from({ length: 220 }, (_, at) => [`file${at}${"x".repeat(40)}`, "none\n"])) });
  const result = await f.collect(head, head, [seed(head)]);
  assert.deepEqual([result.status, result.gaps], ["unknown", ["command_output_cap"]]);
});

test("hit, snippet and whole JSON caps retain explicit partial status", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": `${"permit\n".repeat(40)}` });
  const hits = await f.collect(head, head, [seed(head)]);
  assert.equal(hits.status, "partial");
  assert.ok(hits.gaps.includes("hit_count_cap"));
  assert.ok(hits.candidates.length <= 32); assert.ok(Buffer.byteLength(JSON.stringify(hits)) <= 8192);
  const text = `permit ${"漢".repeat(200)}`;
  const unicode = f.snapshot({ "producer.ts": `${text}\n` });
  const value = await f.collect(unicode, unicode, [seed(unicode)]);
  assert.equal(value.status, "complete_literal_search");
  assert.equal(value.candidates[0].snippetTruncated, true);
  assert.equal(value.candidates[0].snippet, `permit ${"漢".repeat(77)}`);
  const longName = `${"a".repeat(800)}.ts`;
  const json = f.snapshot({ [longName]: `${"permit\n".repeat(10)}` });
  const bounded = await f.collect(json, json, [seed(json, longName)]);
  assert.equal(bounded.status, "partial"); assert.ok(bounded.gaps.includes("json_bytes_cap"));
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) <= 8192);
});

test("caller monotonic deadline and pre-abort spawn nothing", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
  const abort = new AbortController(); abort.abort();
  assert.deepEqual((await f.collect(head, head, [seed(head)], { abortSignal: abort.signal })).gaps, ["aborted"]);
  const expired = await f.collect(head, head, [seed(head)], { reviewDeadlineMs: performance.now() - 1 });
  assert.deepEqual([expired.status, expired.gaps], ["unknown", ["deadline"]]);
});

for (const reason of ["deadline", "aborted", "command_output_cap"] as const) {
  test(`owned Git fake ${reason} kills its descendant group and waits for close`, { skip: process.platform === "win32", timeout: 5000 }, async (t) => {
    const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
    const bin = path.join(f.root, "git"); const pids = path.join(f.root, "pids");
    writeFileSync(bin, `#!${process.execPath}\nconst {spawn}=require('node:child_process');const fs=require('node:fs');
      const child=spawn(process.execPath,['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)']);
      process.on('SIGTERM',()=>{}); child.stdout.on('data',()=>{
        fs.writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));
        ${reason === "command_output_cap" ? 'process.stdout.write("x".repeat(20000));' : ""}
      }); setInterval(()=>{},1000);\n`);
    chmodSync(bin, 0o755);
    const previous = process.env.PATH; process.env.PATH = `${f.root}:${previous}`;
    t.after(() => { process.env.PATH = previous; });
    const abort = new AbortController();
    let timer: ReturnType<typeof setInterval> | undefined;
    if (reason === "aborted") timer = setInterval(() => { if (existsSync(pids)) abort.abort(); }, 10);
    let result: Awaited<ReturnType<typeof f.collect>>;
    try {
      result = await f.collect(head, head, [seed(head)], { abortSignal: abort.signal,
        reviewDeadlineMs: reason === "deadline" ? performance.now() + 500 : undefined });
    } finally { if (timer) clearInterval(timer); }
    assert.deepEqual([result.status, result.gaps], ["unknown", [reason]]);
    const [pgid, child] = JSON.parse(readFileSync(pids, "utf8"));
    const end = performance.now() + 1000;
    while (performance.now() < end) {
      try { process.kill(-pgid, 0); } catch { break; }
      await delay(10);
    }
    assert.throws(() => process.kill(-pgid, 0), { code: "ESRCH" });
    assert.throws(() => process.kill(child, 0), { code: "ESRCH" });
  });
}


test("sealed Git environment ignores ambient repo, global replacement policy and command config", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
  const marker = path.join(f.root, "executed");
  const command = path.join(f.root, "forbidden");
  writeFileSync(command, `#!/bin/sh\nprintf forbidden > '${marker}'\n`); chmodSync(command, 0o755);
  f.git(["config", "core.fsmonitor", command]);
  f.git(["config", "core.hooksPath", command]);
  const ambient = fixture(t); const other = ambient.snapshot({ "producer.ts": "wrong\n" });
  ambient.git(["update-ref", "refs/heads/main", other]);
  const settings = { GIT_DIR: path.join(ambient.root, ".git"), GIT_WORK_TREE: ambient.root,
    GIT_CONFIG_GLOBAL: command, GIT_CONFIG_SYSTEM: command, GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: command };
  const old = Object.fromEntries(Object.keys(settings).map((key) => [key, process.env[key]]));
  Object.assign(process.env, settings);
  try {
    const result = await f.collect(head, head, [seed(head)]);
    assert.equal(result.status, "complete_literal_search"); assert.deepEqual(locations(result), ["producer.ts:1"]);
    assert.equal(existsSync(marker), false);
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("a nested non-repository path cannot fall back to its parent Git directory", async (t) => {
  const f = fixture(t); const head = f.snapshot({ "producer.ts": "permit\n" });
  const nested = path.join(f.root, "nested"); mkdirSync(nested);
  const result = await collectLiteralContext({ snapshot: { repoPath: nested, expectedBaseSha: head, expectedHeadSha: head }, seeds: [seed(head)] });
  assert.deepEqual([result.status, result.gaps], ["unknown", ["git_read_failed"]]);
});

test("invalid anchor bytes remain unknown and bounded tree bytes apply across both revisions", async (t) => {
  const f = fixture(t); const invalid = f.snapshot({ "producer.ts": Buffer.from([0xff, 112, 101, 114, 109, 105, 116]) });
  const result = await f.collect(invalid, invalid, [seed(invalid)]);
  assert.deepEqual([result.status, result.gaps], ["unknown", ["invalid_utf8", "anchor_unverified"]]);
  const files = Object.fromEntries(Array.from({ length: 70 }, (_, at) => [`file${at}${"x".repeat(70)}`, "none\n"]));
  const base = f.snapshot({ "producer.ts": "permit = true\n", ...files });
  const head = f.snapshot({ "producer.ts": "permit = false\n", ...files });
  const combined = await f.collect(base, head, [seed(head)]);
  assert.deepEqual([combined.status, combined.gaps], ["unknown", ["command_output_cap"]]);
});
