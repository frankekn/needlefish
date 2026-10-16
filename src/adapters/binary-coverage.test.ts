import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runLocal } from "./local.js";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { renderMarkdown } from "../shared/render.js";
import { parseReviewResult } from "../shared/review-result.js";
import { serializeReviewResult } from "../shared/schema.js";

for (const localMode of ["branch", "uncommitted"] as const) {
  test(`${localMode} review reports binary contents without changing the verdict`, async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-binary-coverage-"));
    const repo = initRepo(tmp);
    const bin = path.join(tmp, "codex.cjs");
    const promptLog = path.join(tmp, "prompts.txt");
    const previous = process.env.CODEX_BIN;
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
      rmSync(tmp, { recursive: true, force: true });
    });
    writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => prompt += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(promptLog)}, prompt + '\\n<<<END>>>\\n');
  fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify({summary:'checked source', findings:[], checked:['source reviewed'], residual_risks:[]}));
});
`);
    chmodSync(bin, 0o755);
    process.env.CODEX_BIN = bin;
    const binary = "new\n測試[1].bin";
    writeFileSync(path.join(repo, binary), Buffer.from([0, 1]));
    writeFileSync(path.join(repo, "deleted.bin"), Buffer.from([0, 2]));
    writeFileSync(path.join(repo, "old.bin"), Buffer.from([0, 3]));
    writeFileSync(path.join(repo, "app.ts"), "export const n = 1;\n");
    commitAll(repo, "binary base");
    const base = gitText(["rev-parse", "HEAD"], repo);
    writeFileSync(path.join(repo, binary), Buffer.from([0, 4]));
    rmSync(path.join(repo, "deleted.bin"));
    gitText(["mv", "old.bin", "renamed.bin"], repo);
    writeFileSync(path.join(repo, "renamed.bin"), Buffer.from([0, 5]));
    writeFileSync(path.join(repo, "app.ts"), "export const n = 2;\n");
    if (localMode === "branch") commitAll(repo, "binary changes");
    else {
      writeFileSync(path.join(repo, "untracked.bin"), Buffer.from([0, 9]));
      writeFileSync(path.join(repo, ".gitattributes"), "*.opaque -diff\n");
      writeFileSync(path.join(repo, "text.opaque"), "attribute-marked text\n");
    }
    const cacheDir = path.join(tmp, "cache");
    const result = await runLocal(repo, { runner: "codex", base, localMode, cacheDir });
    const expected = ["deleted.bin", binary, "old.bin", "renamed.bin"];
    if (localMode === "uncommitted") expected.push("text.opaque", "untracked.bin");
    assert.deepEqual(result.coverageGaps, expected.map(file => ({kind:"binary_not_reviewed", file})));
    assert.equal(result.verdict, "pass");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.residualRisks, []);
    assert.match(renderMarkdown(result), /Not reviewed \(non-blocking\).*binary/s);
    assert.deepEqual(parseReviewResult(serializeReviewResult(result)), result);
    assert.deepEqual(parseReviewResult(readFileSync(path.join(cacheDir, "last-review.json"), "utf8")), result);
    const prompts = readFileSync(promptLog, "utf8");
    assert.ok(prompts.includes("export const n = 2;"));
    assert.ok(!prompts.includes("binaryFiles"));
    assert.ok(!prompts.includes("binary_not_reviewed"));
  });
}
