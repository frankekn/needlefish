import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";

for (const unborn of [false, true]) {
  test(`CLI deep review inspects WORKING diff (${unborn ? "unborn" : "existing"} repo)`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-local-working-refs-"));
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const repo = unborn ? path.join(tmp, "repo") : initRepo(tmp);
    if (unborn) {
      mkdirSync(repo);
      gitText(["init", "--quiet"], repo);
    }
    writeFileSync(path.join(repo, "app.ts"), "export const answer = 42;\n");
    const bin = path.join(tmp, "claude.cjs");
    writeFileSync(bin, `#!/usr/bin/env node
const cp = require('node:child_process');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  if (prompt.includes('review-MAP pass')) {
    process.stdout.write(JSON.stringify({summary:'mapped',hotspots:[{name:'app',files:['app.ts'],risk:'high',why:'changed',edges:[]}]}));
    return;
  }
  const base = prompt.match(/^BASE: (.+)$/m)?.[1];
  const head = prompt.match(/^HEAD: (.+)$/m)?.[1];
  const diff = cp.spawnSync('git', ['diff', base + '..' + head, '--', 'app.ts'], {encoding:'utf8'});
  if (diff.status !== 0 || !diff.stdout.includes('+export const answer = 42;')) process.exit(1);
  process.stdout.write(JSON.stringify({summary:'inspected',findings:[],checked:['app.ts new answer=42 verified via diff'],residual_risks:[]}));
});
`);
    chmodSync(bin, 0o755);
    const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve("src/cli.ts"), "--repo", repo, "--deep", "--runner", "claude", "--json"], {
      encoding: "utf8", env: { ...process.env, HOME: path.join(tmp, "home"), CLAUDE_BIN: bin,
        NEEDLEFISH_NO_RETRY: "1", NEEDLEFISH_NO_FAST_PATH: "1", NEEDLEFISH_EPHEMERAL_HOME: "0" },
    });
    assert.equal(result.status, 0, result.stderr);
    const review = JSON.parse(result.stdout) as { verdict: string; checked: string[]; headSha: string; residualRisks: unknown[] };
    assert.equal(review.headSha, "WORKING");
    assert.equal(review.verdict, "pass");
    assert.deepEqual(review.checked, ["app.ts new answer=42 verified via diff"]);
    assert.deepEqual(review.residualRisks, []);
    assert.equal(gitText(["status", "--porcelain"], repo), "?? app.ts");
  });
}
