import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffBundle } from "../adapters/local.js";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { assertRunnerSandboxClean, prepareRunnerSandbox } from "../shared/runner-sandbox.js";
import { review, reviewWithConnections } from "./review.js";

for (const unborn of [false, true]) {
  for (const deep of [false, true]) {
    test(`WORKING ${deep ? "map/deep" : "review"}, critic, runner and repair retries share one captured tree (${unborn ? "unborn" : "committed"})`, async (t) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-snapshot-"));
      t.after(() => rmSync(tmp, { recursive: true, force: true }));
      const repo = unborn ? path.join(tmp, "repo") : initRepo(tmp);
      if (unborn) {
        mkdirSync(repo);
        gitText(["init", "--quiet"], repo);
      }
      writeFileSync(path.join(repo, "app.ts"), "export const captured = 42;\n");
      writeFileSync(path.join(repo, "other.ts"), "export const other = 1;\n");
      const { bundle } = diffBundle(repo, { deep });
      const originalStatus = gitText(["status", "--porcelain"], repo);
      if (!unborn) {
        writeFileSync(path.join(repo, "later.ts"), "export const later = true;\n");
        commitAll(repo, "source advanced after capture");
      }
      const bin = path.join(tmp, "claude.cjs");
      const records = path.join(tmp, "records.jsonl");
      writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  const git = args => cp.execFileSync('git', args, {encoding:'utf8'}).trim();
  const count = fs.existsSync(${JSON.stringify(records)}) ? fs.readFileSync(${JSON.stringify(records)}, 'utf8').trim().split('\\n').length : 0;
  const map = prompt.includes('review-MAP pass');
  const refs = map ? JSON.parse(prompt.slice(prompt.lastIndexOf('\\n{') + 1)) : null;
  const base = refs?.baseSha ?? prompt.match(/^BASE: (.+)$/m)?.[1] ?? ${JSON.stringify(bundle.baseSha)};
  const head = refs?.headSha ?? prompt.match(/^HEAD: (.+)$/m)?.[1] ?? 'WORKING';
  git(['rev-parse','--verify',base + '^{commit}']);
  git(['rev-parse','--verify',head + '^{commit}']);
  const diff = git(['diff',base + '..' + head]);
  if (!diff.includes('+export const captured = 42;') || fs.existsSync('later.ts')) throw Error('review tree changed');
  if (fs.readFileSync('app.ts','utf8') !== 'export const captured = 42;\\n') throw Error('source edit leaked');
  fs.appendFileSync(${JSON.stringify(records)}, JSON.stringify({tree:git(['rev-parse','HEAD^{tree}']),head:git(['rev-parse','HEAD']),cwd:process.cwd(),diff}) + '\\n');
  if (count === 0) {
    fs.rmSync(${JSON.stringify(path.join(repo, ".git"))}, {recursive:true,force:true});
    fs.writeFileSync(${JSON.stringify(path.join(repo, "app.ts"))}, 'source changed after first pass\\n');
    fs.writeFileSync(${JSON.stringify(path.join(repo, "new.ts"))}, 'new source file\\n');
    process.exit(1);
  }
  if (count === 1) {
    process.stdout.write('malformed first response');
    return;
  }
  process.stdout.write(JSON.stringify(map
    ? {summary:'mapped',hotspots:[{name:'app',files:['app.ts'],risk:'high',why:'changed',edges:[]},{name:'other',files:['other.ts'],risk:'low',why:'changed',edges:[]}]}
    : {summary:'inspected',findings:[],checked:['FILES inspected=[app.ts,other.ts]'],residual_risks:[]}));
});
`);
      chmodSync(bin, 0o755);
      const previous = { ...process.env };
      const managedRoot = path.join(tmp, "managed");
      Object.assign(process.env, { CLAUDE_BIN: bin, NEEDLEFISH_EPHEMERAL_HOME: "0", NEEDLEFISH_NO_RETRY: "0", NEEDLEFISH_RETRY_MS: "1", NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_TMPDIR: managedRoot });
      t.after(() => { process.env = previous; });
      const result = await review(bundle, { runner: "claude", timeoutMs: 5000 });
      assert.equal(result.verdict, "pass");
      assert.equal(result.headSha, "WORKING");
      assert.equal(result.baseSha, bundle.baseSha);
      assert.match(result.reviewTarget ?? "", /captured snapshot/);
      const rows: { tree: string; head: string; cwd: string; diff: string }[] = readFileSync(records, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.ok(rows.length >= (deep ? 6 : 4));
      assert.equal(new Set(rows.map(row => row.tree)).size, 1);
      assert.equal(new Set(rows.map(row => row.head)).size, 1);
      assert.equal(new Set(rows.map(row => row.cwd)).size, rows.length);
      assert.ok(rows.every(row => row.diff === rows[0]?.diff));
      assert.ok(rows.every(row => !existsSync(row.cwd)));
      assert.deepEqual(readdirSync(managedRoot).filter(name => /^needlefish-(?:managed-)?/.test(name)), []);
      assert.equal(readFileSync(path.join(repo, "app.ts"), "utf8"), "source changed after first pass\n");
      assert.match(originalStatus, /app\.ts/);
    });
  }
}

test("WORKING snapshot preparation failure removes its managed baseline and preserves the source", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-snapshot-failure-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "app.ts"), "export const captured = 42;\n");
  const { bundle } = diffBundle(repo, {});
  const originalHead = gitText(["rev-parse", "HEAD"], repo);
  const originalStatus = gitText(["status", "--porcelain"], repo);
  const managedRoot = path.join(tmp, "managed");
  const previous = process.env.NEEDLEFISH_TMPDIR;
  process.env.NEEDLEFISH_TMPDIR = managedRoot;
  t.after(() => {
    if (previous === undefined) delete process.env.NEEDLEFISH_TMPDIR;
    else process.env.NEEDLEFISH_TMPDIR = previous;
  });
  await assert.rejects(review({ ...bundle, patch: "invalid patch" }, { runner: "claude" }), /git apply/);
  assert.deepEqual(readdirSync(managedRoot).filter(name => /^needlefish-(?:managed-)?/.test(name)), []);
  assert.equal(gitText(["rev-parse", "HEAD"], repo), originalHead);
  assert.equal(gitText(["status", "--porcelain"], repo), originalStatus);
  assert.equal(readFileSync(path.join(repo, "app.ts"), "utf8"), "export const captured = 42;\n");
});

for (const deleteRefs of [false, true]) {
  test(`captured committed base survives unborn source HEAD (${deleteRefs ? "all refs deleted" : "base ref retained"})`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-unborn-branch-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const repo = initRepo(tmp);
    writeFileSync(path.join(repo, "app.ts"), "export const captured = 42;\n");
    const { bundle } = diffBundle(repo, {});
    gitText(["symbolic-ref", "HEAD", "refs/heads/later-unborn"], repo);
    if (deleteRefs) {
      for (const ref of gitText(["for-each-ref", "--format=%(refname)"], repo).split("\n")) {
        gitText(["update-ref", "-d", ref], repo);
      }
      assert.equal(gitText(["for-each-ref"], repo), "");
    }
    const sandboxTmp = path.join(tmp, "sandbox");
    mkdirSync(sandboxTmp);
    const sandbox = prepareRunnerSandbox({
      runner: "claude", repoPath: repo, prompt: "", tmp: sandboxTmp,
      targetBaseSha: bundle.baseSha, targetHeadSha: bundle.headSha, targetPatch: bundle.patch,
    });
    assert.equal(readFileSync(path.join(sandbox.repoPath, "README.md"), "utf8"), "fixture\n");
    assert.equal(readFileSync(path.join(sandbox.repoPath, "app.ts"), "utf8"), "export const captured = 42;\n");
    assert.equal(gitText(["rev-parse", "HEAD^"], sandbox.repoPath), bundle.baseSha);
    assert.equal(gitText(["symbolic-ref", "HEAD"], repo), "refs/heads/later-unborn");
    assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);
  });
}

for (const unborn of [false, true]) {
  for (const ordered of [false, true]) {
    test(`quoted findings use captured fixed refs with ${unborn ? "EMPTY" : "committed"} base (${ordered ? "ordered" : "singleton"})`, async (t) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-quotes-"));
      const previous = { ...process.env };
      t.after(() => { process.env = previous; rmSync(tmp, { recursive: true, force: true }); });
      const repo = unborn ? path.join(tmp, "repo") : initRepo(tmp);
      if (unborn) { mkdirSync(repo); gitText(["init", "--quiet"], repo); }
      if (!unborn) {
        writeFileSync(path.join(repo, "app.ts"), "export const removed = oldValue();\n");
        commitAll(repo, "base quote");
      }
      writeFileSync(path.join(repo, "app.ts"), "export const captured = unsafeValue();\nexport const moved = anotherValue();\n");
      const { bundle } = diffBundle(repo, {});
      const records = path.join(tmp, "records.jsonl");
      const bin = path.join(tmp, "claude.cjs");
      const common = { severity: "P2", title: "Captured bug", category: "bug", confidence: 0.9, whyItBreaks: "unsafe value", suggestedFix: "validate", validation: "test", file: "app.ts", lineStart: 1, lineEnd: 1, replacement: { lines: ["fixed();"] } };
      const findings = [
        { ...common, quote: "export const captured = unsafeValue();" },
        { ...common, title: "Moved quote", quote: "export const moved = anotherValue();" },
        { ...common, title: "Removed quote", quote: "export const removed = oldValue();" },
      ];
      writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),cp=require('node:child_process');
const prompt=fs.readFileSync(0,'utf8');
const git=args=>cp.execFileSync('git',args,{encoding:'utf8'}).trim();
fs.appendFileSync(${JSON.stringify(records)},JSON.stringify({prompt,head:git(['rev-parse','HEAD']),base:git(['rev-parse','HEAD^']),source:fs.readFileSync('app.ts','utf8')})+'\\n');
fs.rmSync(${JSON.stringify(path.join(repo, ".git"))},{recursive:true,force:true});
fs.writeFileSync(${JSON.stringify(path.join(repo, "app.ts"))},'source changed after capture\\n');
process.stdout.write(${JSON.stringify(JSON.stringify({ summary: "captured quotes", findings, checked: ["app.ts"], residual_risks: [] }))});
`);
      chmodSync(bin, 0o755);
      Object.assign(process.env, { CLAUDE_BIN: bin, NEEDLEFISH_NO_RETRY: "1", NEEDLEFISH_REVIEW_TIMEOUT_MS: "15000" });
      const routes = [{ runner: "claude", model: "first" }, { runner: "claude", model: "second" }] as const;
      const result = ordered ? await reviewWithConnections(bundle, routes) : await review(bundle, routes[0]);
      assert.equal(result.headSha, "WORKING");
      assert.equal(result.baseSha, unborn ? "EMPTY" : bundle.baseSha);
      assert.equal(result.verdict, "changes_requested");
      assert.deepEqual(result.findings.map(f => f.quoteCheck), [
        { status: "matched" }, { status: "moved", from: "app.ts:1" }, { status: unborn ? "not_found" : "unchecked" },
      ]);
      assert.deepEqual(result.findings[0]?.replacement, { lines: ["fixed();"] });
      assert.equal(result.findings[1]?.lineStart, 2);
      assert.equal(result.findings[1]?.replacement, undefined);
      assert.equal(result.findings[2]?.replacement, undefined);
      const rows: { prompt: string; head: string; base: string; source: string }[] = readFileSync(records, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.equal(rows.length, 2);
      assert.equal(new Set(rows.map(row => row.head)).size, 1);
      assert.equal(new Set(rows.map(row => row.base)).size, 1);
      assert.ok(rows.every(row => /^[a-f0-9]{40}$/.test(row.head) && /^[a-f0-9]{40}$/.test(row.base)));
      assert.ok(rows.every(row => row.source === "export const captured = unsafeValue();\nexport const moved = anotherValue();\n"));
      assert.match(rows[0]?.prompt ?? "", /"headSha": "WORKING"/);
      assert.match(rows[0]?.prompt ?? "", unborn ? /"baseSha": "EMPTY"/ : new RegExp(bundle.baseSha));
      assert.match(rows[1]?.prompt ?? "", /^HEAD: WORKING$/m);
      assert.equal(existsSync(path.join(repo, ".git")), false);
      assert.equal(readFileSync(path.join(repo, "app.ts"), "utf8"), "source changed after capture\n");
    });
  }
}
