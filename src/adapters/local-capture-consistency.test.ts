import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
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
if (!fs.existsSync(${JSON.stringify(path.join(tmp, "changed"))}) && args[0] === 'diff' && ${change === "untracked" ? "args.includes('--no-index')" : "!args.some(arg => arg.startsWith('--'))"}) {
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
    assert.equal(gitText(["status", "--porcelain"], repo).includes("app.ts"), true);
  });
}
