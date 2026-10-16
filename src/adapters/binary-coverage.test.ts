import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review } from "../core/review.js";
import { prDiffFromShas } from "../shared/repo.js";
import { runLocal } from "./local.js";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { renderMarkdown } from "../shared/render.js";
import { parseReviewResult } from "../shared/review-result.js";
import { serializeReviewResult } from "../shared/schema.js";

for (const [localMode, binaryOnly] of [["branch", false], ["uncommitted", false], ["branch", true]] as const) {
  test(`${localMode}${binaryOnly ? " binary-only" : ""} review reports binary contents without changing the verdict`, async (t) => {
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
    const binary = "new\n測試[1].bin \t\n";
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
    if (!binaryOnly) writeFileSync(path.join(repo, "app.ts"), "export const n = 2;\n");
    if (localMode === "branch") {
      commitAll(repo, "binary changes");
      const diff = prDiffFromShas(repo, base, gitText(["rev-parse", "HEAD"], repo));
      assert.deepEqual(diff.binaryFiles, ["deleted.bin", binary, "old.bin", "renamed.bin"]);
      assert.match(diff.patch, /Binary files/);
    }
    else {
      writeFileSync(path.join(repo, "untracked.bin"), Buffer.from([0, 9]));
      writeFileSync(path.join(repo, ".gitattributes"), "*.opaque -diff\n");
      writeFileSync(path.join(repo, "text.opaque"), "attribute-marked text\n");
    }
    const cacheDir = path.join(tmp, "cache");
    const result = await runLocal(repo, { runner: "codex", base, localMode, cacheDir });
    const expected = ["deleted.bin", binary, "old.bin", "renamed.bin"];
    if (localMode === "uncommitted") expected.push("text.opaque", "untracked.bin");
    assert.deepEqual(result.unreviewedBinaryFiles, expected);
    assert.equal(result.verdict, "pass");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.residualRisks, []);
    assert.match(renderMarkdown(result), /Not reviewed \(non-blocking\).*binary/s);
    assert.deepEqual(parseReviewResult(JSON.parse(serializeReviewResult(result))), result);
    assert.deepEqual(parseReviewResult(JSON.parse(readFileSync(path.join(cacheDir, "last-review.json"), "utf8"))), result);
    const prompts = readFileSync(promptLog, "utf8");
    assert.ok(prompts.includes(binaryOnly ? "Binary files" : "export const n = 2;"));
    assert.ok(!prompts.includes("binaryFiles"));
    assert.ok(!prompts.includes("unreviewedBinaryFiles"));
  });
}


test("docs fast path retains non-blocking binary coverage and old v1 results remain readable", async () => {
  const result = await review({
    repoPath: "/unused",
    baseSha: "base",
    headSha: "head",
    patch: "Binary files a/docs/notes.md and b/docs/notes.md differ\n",
    patchStat: "notes.md | Bin 1 -> 2 bytes",
    changedFiles: [{ path: "docs/notes.md", surface: "docs" }],
    binaryFiles: ["docs/notes.md", "docs/notes.md"],
    agentsMd: "(none)",
    prMeta: null,
    deep: false,
    focus: null,
  });
  assert.equal(result.verdict, "pass");
  assert.deepEqual(result.unreviewedBinaryFiles, ["docs/notes.md"]);
  const { unreviewedBinaryFiles, ...oldV1 } = result;
  assert.deepEqual(parseReviewResult(JSON.parse(serializeReviewResult(oldV1))), oldV1);
  assert.match(renderMarkdown(result), /- docs\/notes.md/);
  assert.ok(!renderMarkdown(result, { omitCoverageGaps: true }).includes("Not reviewed"));
  assert.deepEqual(unreviewedBinaryFiles, ["docs/notes.md"]);
});

for (const fastPath of ["binary-only", "docs-only"] as const) {
  test(`${fastPath} fast path discloses attribute-classified pointers without a runner`, async (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-binary-pointer-"));
    const repo = initRepo(tmp);
    t.after(() => rmSync(tmp, { recursive: true, force: true }));
    const file = "asset.bin";
    writeFileSync(path.join(repo, ".gitattributes"), `${file} filter=lfs -diff\n`);
    writeFileSync(path.join(repo, file), "old contents\n");
    commitAll(repo, "base");
    writeFileSync(path.join(repo, file), `version https://git-lfs.github.com/spec/v1\noid sha256:${"a".repeat(64)}\nsize 123\n`);
    if (fastPath === "docs-only") writeFileSync(path.join(repo, "README.md"), "New notes\n");

    const previous = process.env.CODEX_BIN;
    process.env.CODEX_BIN = path.join(tmp, "must-not-run");
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = previous;
    });
    const result = await runLocal(repo, {
      localMode: "uncommitted", runner: "codex", cacheDir: path.join(tmp, "cache"),
    });
    assert.equal(result.verdict, "pass");
    assert.match(result.summary, /model review skipped/);
    assert.deepEqual(result.unreviewedBinaryFiles, [file]);
    assert.equal(result.coverageGaps, undefined);
    assert.match(renderMarkdown(result), /Not reviewed \(non-blocking\)/);
  });
}
