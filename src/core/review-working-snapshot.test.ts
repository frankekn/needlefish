import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { diffBundle } from "../adapters/local.js";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { assertRunnerSandboxClean, prepareRunnerSandbox } from "../shared/runner-sandbox.js";
import { review } from "./review.js";

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

test("captured committed base survives the source switching to an unborn branch", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-working-unborn-branch-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "app.ts"), "export const captured = 42;\n");
  const { bundle } = diffBundle(repo, {});
  gitText(["symbolic-ref", "HEAD", "refs/heads/later-unborn"], repo);
  const sandboxTmp = path.join(tmp, "sandbox");
  mkdirSync(sandboxTmp);
  const sandbox = prepareRunnerSandbox({
    runner: "claude", repoPath: repo, prompt: "", tmp: sandboxTmp,
    targetBaseSha: bundle.baseSha, targetHeadSha: bundle.headSha, targetPatch: bundle.patch,
  });
  assert.equal(readFileSync(path.join(sandbox.repoPath, "README.md"), "utf8"), "fixture\n");
  assert.equal(gitText(["rev-parse", "HEAD^"], sandbox.repoPath), bundle.baseSha);
  assert.equal(gitText(["symbolic-ref", "HEAD"], repo), "refs/heads/later-unborn");
  assertRunnerSandboxClean("claude", sandbox.repoPath, sandbox.expectedHeadSha);
});
