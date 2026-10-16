import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { parseReviewResult } from "../shared/review-result.js";

for (const mode of ["local", "pr"] as const) {
  for (const outcome of ["pass", "changes_requested", "needs_human", "deep-failure", "malformed", "unavailable", "timeout"] as const) {
    test(`${mode} CLI ${outcome} exits ${outcome === "pass" ? 0 : 1}`, (t) => {
      const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-exit-test-"));
      t.after(() => rmSync(tmp, { recursive: true, force: true }));
      const repo = initRepo(tmp);
      gitText(["branch", "-M", "main"], repo);
      const base = headSha(repo);
      gitText(["checkout", "-b", "feature"], repo);
      writeFileSync(path.join(repo, "app.ts"), "export const app = 1;\n");
      writeFileSync(path.join(repo, "auth.ts"), "export const auth = true;\n");
      commitAll(repo, "feature");
      const head = headSha(repo);
      const bin = path.join(tmp, "bin");
      mkdirSync(bin);
      const gh = path.join(bin, "gh");
      writeFileSync(gh, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({number:7,title:'PR',body:null,comments:[],reviews:[],statusCheckRollup:[],baseRefOid:${JSON.stringify(base)},headRefOid:${JSON.stringify(head)},baseRefName:'main',headRefName:'feature'}));
`);
      chmodSync(gh, 0o755);
      const runner = path.join(bin, "claude");
      const review = {
        summary: "Review result",
        findings: outcome === "changes_requested" ? [{
          severity: "P2", title: "Broken auth", category: "bug", file: "auth.ts",
          lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: "w", suggestedFix: "f", validation: "",
        }] : [],
        checked: ["app.ts inspected"],
        residual_risks: outcome === "needs_human" ? [{ text: "auth.ts not reviewed", blocks: true }] : [],
      };
      writeFileSync(runner, `#!/usr/bin/env node
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  if (${JSON.stringify(outcome)} === 'timeout') { setTimeout(() => {}, 10000); return; }
  if (${JSON.stringify(outcome)} === 'malformed') { process.stdout.write('not json'); return; }
  if (prompt.includes('review-MAP pass')) {
    process.stdout.write(JSON.stringify({summary:'mapped',hotspots:[{name:'app',files:['app.ts'],risk:'high',why:'changed',edges:[]},{name:'auth',files:['auth.ts'],risk:'high',why:'changed',edges:[]}]})); return;
  }
  if (prompt.includes('doing a DEEP review') && prompt.includes('"name": "auth"')) {
    process.stdout.write('not json'); return;
  }
  process.stdout.write(${JSON.stringify(JSON.stringify(review))});
});
`);
      chmodSync(runner, 0o755);
      const home = path.join(tmp, "home");
      const args = mode === "pr" ? ["pr", "7"] : [];
      const result = spawnSync(process.execPath, [
        "--import", "tsx", path.resolve("src/cli.ts"), ...args,
        "--repo", repo, "--runner", "claude", "--json",
        ...(outcome === "deep-failure" ? ["--deep"] : []),
        ...(outcome === "timeout" ? ["--timeout-ms", "500"] : []),
      ], { encoding: "utf8", env: {
        ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home,
        CLAUDE_BIN: outcome === "unavailable" ? path.join(tmp, "missing-claude") : runner,
        NEEDLEFISH_NO_RETRY: "1", NEEDLEFISH_NO_FAST_PATH: "1",
      } });
      assert.equal(result.status, outcome === "pass" ? 0 : 1, `${result.stderr}\n${result.stdout}`);
      if (outcome === "malformed" || outcome === "unavailable" || outcome === "timeout") {
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /needlefish:/);
        return;
      }
      const reviewResult = parseReviewResult(JSON.parse(result.stdout));
      assert.equal(reviewResult.verdict, outcome === "deep-failure" ? "needs_human" : outcome);
      assert.equal(readFileSync(path.join(home, ".cache", "needlefish", "repo", "last-review.json"), "utf8"), result.stdout);
      if (outcome === "deep-failure") {
        assert.match(reviewResult.coverage ?? "", /1\/2 changed files deep-reviewed/);
        assert.ok(reviewResult.residualRisks.some(risk => risk.blocks && risk.text.includes('"auth" failed')));
      }
    });
  }
}
