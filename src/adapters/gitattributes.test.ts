// Issue #213: a PR that adds a `.gitattributes` line such as `* -diff` or
// `* binary` used to hide every hunk from the review patch, because git
// applied the head-commit attributes to `git diff <base> <head>`. Review
// patches must be attribute-neutral, and files that are genuinely binary by
// content must be reported as coverage gaps instead of vanishing.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { contentBinaryPaths, prDiffFromShas } from "../shared/repo.js";
import { diffBundle } from "./local.js";

const NUL_BYTES = Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]);

function makeRepo(tmp: string): string {
  const repo = initRepo(tmp);
  gitText(["branch", "-M", "main"], repo);
  return repo;
}

/** base commit -> head commit adding `.gitattributes`, a code hunk, and a real binary change. */
function attributeHead(repo: string, attributeLine: string): { baseSha: string; headSha: string } {
  const baseSha = headSha(repo);
  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "pixel.bin"), NUL_BYTES);
  commitAll(repo, "base2");
  writeFileSync(path.join(repo, ".gitattributes"), attributeLine);
  writeFileSync(path.join(repo, "app.ts"), "export const a = eval(process.env.X!);\n");
  commitAll(repo, "hide with .gitattributes");
  return { baseSha, headSha: headSha(repo) };
}

test("branch-mode bundle shows real hunks through `* -diff` (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-nodiff-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { baseSha } = attributeHead(repo, "* -diff\n");

  const { bundle } = diffBundle(repo, { localMode: "branch", base: baseSha });

  assert.match(bundle.patch, /^\+export const a = eval\(process\.env\.X!\);$/m);
  assert.match(bundle.patch, /^\+\* -diff$/m);
  assert.equal(bundle.patch.includes("Binary files"), false);
  assert.deepEqual(bundle.binarySkipped, ["pixel.bin"]);
});

test("committed-range diff shows real hunks through `* binary` (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-binary-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { baseSha, headSha: head } = attributeHead(repo, "* binary\n");

  const diff = prDiffFromShas(repo, baseSha, head);

  assert.match(diff.patch, /^\+export const a = eval\(process\.env\.X!\);$/m);
  assert.match(diff.patch, /^\+\* binary$/m);
  assert.equal(diff.patch.includes("Binary files"), false);
  assert.deepEqual(diff.binarySkipped, ["pixel.bin"]);
});

test("uncommitted bundle shows real hunks through a committed `* -diff` (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-uncommitted-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "pixel.bin"), NUL_BYTES);
  commitAll(repo, "base2");
  writeFileSync(path.join(repo, ".gitattributes"), "* -diff\n");
  commitAll(repo, "attributes");
  writeFileSync(path.join(repo, "app.ts"), "export const a = eval(process.env.X!);\n");
  writeFileSync(path.join(repo, "pixel.bin"), Buffer.from([0x89, 0x00, 0x50, 0x01]));

  const { bundle } = diffBundle(repo, {});

  assert.match(bundle.patch, /^\+export const a = eval\(process\.env\.X!\);$/m);
  assert.equal(bundle.patch.includes("Binary files"), false);
  assert.deepEqual(bundle.binarySkipped, ["pixel.bin"]);
});

test("untracked new files survive `* -diff` (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-untracked-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, ".gitattributes"), "* -diff\n");
  commitAll(repo, "attributes");
  writeFileSync(path.join(repo, "fresh.ts"), "export const fresh = 1;\n");

  const { bundle } = diffBundle(repo, {});

  assert.match(bundle.patch, /^\+export const fresh = 1;$/m);
});

test("textconv attributes cannot rewrite patch content (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-textconv-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "notes.txt"), "old txt\n");
  commitAll(repo, "base2");
  writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=tr\n");
  gitText(["config", "diff.tr.textconv", "tr a-z A-Z"], repo);
  commitAll(repo, "attribute textconv");
  writeFileSync(path.join(repo, "notes.txt"), "new txt\n");
  commitAll(repo, "change notes");

  const diff = prDiffFromShas(repo, headSha(repo) + "~2", headSha(repo));

  assert.match(diff.patch, /^\+new txt$/m);
  assert.equal(diff.patch.includes("+NEW TXT"), false);
});

test("binary detection is content-truthed, not attribute-truthed (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-content-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const { baseSha, headSha: head } = attributeHead(repo, "* -diff\n");

  // `* -diff` claims every file is binary to `git diff --numstat`; content
  // says only pixel.bin is.
  assert.deepEqual(
    contentBinaryPaths(repo, head, baseSha, ["app.ts", ".gitattributes", "pixel.bin"]),
    ["pixel.bin"],
  );

  // A path deleted at head is judged by its base-side blob.
  writeFileSync(path.join(repo, "gone.bin"), NUL_BYTES);
  commitAll(repo, "add gone");
  const beforeDelete = headSha(repo);
  rmSync(path.join(repo, "gone.bin"));
  gitText(["add", "-A"], repo);
  commitAll(repo, "remove gone");
  assert.deepEqual(
    contentBinaryPaths(repo, headSha(repo), beforeDelete, ["gone.bin", "app.ts"]),
    ["gone.bin"],
  );
});

test("a path binary only at base is skipped, not inlined by --text (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-baseside-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "pack.bin"), NUL_BYTES);
  commitAll(repo, "binary at base");
  const baseSha = headSha(repo);
  writeFileSync(path.join(repo, "pack.bin"), "plain text now\n");
  writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");
  commitAll(repo, "text at head");

  const diff = prDiffFromShas(repo, baseSha, headSha(repo));
  assert.deepEqual(diff.binarySkipped, ["pack.bin"]);
  assert.equal(diff.patch.includes("\u0000"), false);

  writeFileSync(path.join(repo, "pack.bin"), NUL_BYTES);
  commitAll(repo, "binary again");
  writeFileSync(path.join(repo, "pack.bin"), "text in the work tree\n");
  writeFileSync(path.join(repo, "app.ts"), "export const a = 3;\n");
  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped, ["pack.bin"]);
  assert.equal(bundle.patch.includes("\u0000"), false);
});
