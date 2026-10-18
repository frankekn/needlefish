import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { isDocsOnlyFastPath } from "../core/review.js";
import { diffBundle } from "./local.js";

for (const change of ["HEAD", "tracked", "untracked"]) {
  test(`uncommitted capture rejects a concurrent ${change} change`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-capture-race-"));
    const repo = initRepo(tmp);
    writeFileSync(path.join(repo, "README.md"), "captured tracked\n");
    writeFileSync(path.join(repo, "app.ts"), "export const captured = 1;\n");
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const script = path.join(bin, "git");
    writeFileSync(script, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const result = cp.spawnSync('/usr/bin/git', args, {encoding:'utf8'});
if (!fs.existsSync(${JSON.stringify(path.join(tmp, "changed"))}) && args.includes('diff') && ${change === "untracked" ? "args.includes('--no-index')" : "!args.some(arg => ['--numstat', '--stat', '--name-only', '--no-index'].includes(arg))"}) {
  fs.writeFileSync(${JSON.stringify(path.join(tmp, "changed"))}, 'changed');
  ${change === "HEAD" ? `cp.execFileSync('/usr/bin/git', ['-c','user.name=Test','-c','user.email=test@example.invalid','commit','--allow-empty','-m','concurrent HEAD'], {stdio:'ignore'});` : `fs.writeFileSync(${JSON.stringify(path.join(repo, change === "tracked" ? "README.md" : "app.ts"))}, 'changed during capture\\n');`}
}
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`);
    chmodSync(script, 0o755);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath ?? ""}`;
    t.after(() => {
      process.env.PATH = previousPath;
      rmSync(tmp, { recursive: true, force: true });
    });
    assert.throws(() => diffBundle(repo, {}), /changed while capturing.*retry/i);
    assert.equal(existsSync(path.join(tmp, "changed")), true, "the concurrent mutation must actually run");
    assert.equal(gitText(["status", "--porcelain"], repo).includes("app.ts"), true);
  });
}

test("uncommitted repeated ABA captures classify the captured source patch", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-design-b-aba-"));
  const repo = initRepo(tmp);
  const app = path.join(repo, "app.ts");
  const original = "export const value = 1;\n";
  writeFileSync(app, original);
  commitAll(repo, "source baseline");
  writeFileSync(path.join(repo, "README.md"), "docs stay dirty\n");
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  writeFileSync(wrapper, `#!/usr/bin/env node
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const patch = args.includes('diff') && !args.some(arg => ['--numstat', '--stat', '--name-only', '--no-index'].includes(arg));
if (patch) fs.writeFileSync(${JSON.stringify(app)}, 'export const value = 999;\\n');
const result = cp.spawnSync('/usr/bin/git', args, {encoding:'utf8'});
if (patch) fs.writeFileSync(${JSON.stringify(app)}, ${JSON.stringify(original)});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  const prior = process.env.PATH;
  process.env.PATH = `${bin}:${prior ?? ""}`;
  t.after(() => { process.env.PATH = prior; rmSync(tmp, {recursive:true, force:true}); });
  const { bundle } = diffBundle(repo, {});
  assert.match(bundle.patch, /\+export const value = 999;/);
  assert.deepEqual(bundle.changedFiles.map(file => file.path), ["README.md", "app.ts"]);
  assert.equal(isDocsOnlyFastPath(bundle), false);
  assert.equal(gitText(["status", "--porcelain"], repo).includes("app.ts"), false);
  assert.equal(readFileSync(app, "utf8"), original);
});
