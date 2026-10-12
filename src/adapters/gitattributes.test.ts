// Issue #213: a PR that adds a `.gitattributes` line such as `* -diff` or
// `* binary` used to hide every hunk from the review patch, because git
// applied the head-commit attributes to `git diff <base> <head>`. Review
// patches must be attribute-neutral, and files that are genuinely binary by
// content must be reported as coverage gaps instead of vanishing.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { contentBinaryPaths, prDiffFromShas, reviewDiff } from "../shared/repo.js";
import { classifyUnmatched, touchesSincePrevHead } from "./github.js";
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

test("working-tree-encoding text is judged as git compares it, not by raw bytes (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-wte-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, ".gitattributes"), "*.ps1 working-tree-encoding=UTF-16LE\n");
  writeFileSync(path.join(repo, "script.ps1"), Buffer.from("Write-Host old\n", "utf16le"));
  commitAll(repo, "utf-16 script");
  writeFileSync(path.join(repo, "script.ps1"), Buffer.from("Write-Host new\n", "utf16le"));

  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped ?? [], []);
  assert.match(bundle.patch, /^\+Write-Host new$/m);
});

test("a tracked path under a directory replaced by a file is reviewed as deleted (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-enotdir-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  mkdirSync(path.join(repo, "config"));
  writeFileSync(path.join(repo, "config", "app.ts"), "export const port = 1;\n");
  commitAll(repo, "config dir");
  rmSync(path.join(repo, "config"), { recursive: true });
  writeFileSync(path.join(repo, "config"), "now a file\n");

  const { bundle } = diffBundle(repo, {});
  assert.match(bundle.patch, /^-export const port = 1;$/m);
});

test("changes under a binary file swapped for a directory stay in the patch (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-swap-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "payload"), NUL_BYTES);
  commitAll(repo, "binary payload");
  const baseSha = headSha(repo);
  rmSync(path.join(repo, "payload"));
  mkdirSync(path.join(repo, "payload"));
  writeFileSync(path.join(repo, "payload", "app.ts"), "export const run = eval;\n");
  gitText(["add", "-A"], repo);
  commitAll(repo, "payload becomes a directory");

  const diff = prDiffFromShas(repo, baseSha, headSha(repo));
  assert.deepEqual(diff.binarySkipped, ["payload"]);
  assert.match(diff.patch, /^\+export const run = eval;$/m);
  assert.match(diff.patchStat, /payload\/app\.ts/);
  assert.equal(diff.patch.includes("\u0000"), false);

  const { bundle } = diffBundle(repo, { localMode: "branch", base: baseSha });
  assert.match(bundle.patch, /^\+export const run = eval;$/m);
});

test("re-review history diff skips binary content but keeps source touches (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-history-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  writeFileSync(path.join(repo, "blob.bin"), NUL_BYTES);
  commitAll(repo, "prev");
  const prevHead = headSha(repo);
  writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");
  writeFileSync(path.join(repo, "blob.bin"), Buffer.from([0x00, 0x01, 0x0a, 0x02]));
  commitAll(repo, "head");

  const touches = touchesSincePrevHead(repo, prevHead, headSha(repo));
  assert.ok(touches);
  assert.ok(touches.has("app.ts"));
  assert.equal(touches.get("blob.bin"), null);
  // The binary changed but has no line ranges: a prior finding on it is
  // undetermined, never "code unchanged".
  assert.deepEqual(
    classifyUnmatched([{ file: "blob.bin", lineStart: 1, category: "bug", title: "t" }], touches),
    { code_changed: 0, code_unchanged: 0, undetermined: 1 }
  );
});

for (const [staged, movedInside] of [[true, false], [false, false], [true, true]] as const) {
  test(`an uncommitted binary swapped for a directory yields a patch git apply accepts (staged=${staged}, movedInside=${movedInside}, issue #213)`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-swap-working-"));
    const repo = makeRepo(tmp);
    t.after(() => rmSync(tmp, { recursive: true, force: true }));

    writeFileSync(path.join(repo, "payload"), NUL_BYTES);
    commitAll(repo, "binary payload");
    rmSync(path.join(repo, "payload"));
    mkdirSync(path.join(repo, "payload"));
    writeFileSync(path.join(repo, "payload", "app.ts"), "export const run = eval;\n");
    // Same bytes under the new directory: git sees a rename, not a deletion.
    if (movedInside) writeFileSync(path.join(repo, "payload", "asset.bin"), NUL_BYTES);
    if (staged) gitText(["add", "-A"], repo);

    const { bundle } = diffBundle(repo, {});
    assert.deepEqual(bundle.binarySkipped, movedInside ? ["payload", "payload/asset.bin"] : ["payload"]);
    assert.match(bundle.patch, /^\+export const run = eval;$/m);
    assert.equal(bundle.patch.includes("\u0000"), false);

    // The WORKING sandbox applies the patch to a clone of HEAD.
    const clone = path.join(tmp, "clone");
    gitText(["clone", "--quiet", repo, clone], tmp);
    const patchFile = path.join(tmp, "working.patch");
    writeFileSync(patchFile, bundle.patch);
    gitText(["apply", "--whitespace=nowarn", patchFile], clone);
    assert.equal(readFileSync(path.join(clone, "payload", "app.ts"), "utf8"), "export const run = eval;\n");
  });
}

test("a text file that replaced a binary-holding directory is still reviewed (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-dir-to-file-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  mkdirSync(path.join(repo, "app.ts"));
  writeFileSync(path.join(repo, "app.ts", "asset.bin"), NUL_BYTES);
  writeFileSync(path.join(repo, "README.md"), "# a\n");
  commitAll(repo, "binary under app.ts/");
  rmSync(path.join(repo, "app.ts"), { recursive: true });
  writeFileSync(path.join(repo, "app.ts"), "export const run = eval;\n");
  writeFileSync(path.join(repo, "README.md"), "# b\n");
  gitText(["add", "-A"], repo);

  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped, ["app.ts/asset.bin"]);
  assert.match(bundle.patch, /^\+export const run = eval;$/m);
});

test("a binary file that replaced a text directory yields a patch git apply accepts (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-dir-to-binary-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  mkdirSync(path.join(repo, "payload"));
  writeFileSync(path.join(repo, "payload", "app.ts"), "export const a = 1;\n");
  commitAll(repo, "text under payload/");
  rmSync(path.join(repo, "payload"), { recursive: true });
  writeFileSync(path.join(repo, "payload"), NUL_BYTES);
  gitText(["add", "-A"], repo);

  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped, ["payload"]);
  assert.match(bundle.patch, /^-export const a = 1;$/m);

  const clone = path.join(tmp, "clone");
  gitText(["clone", "--quiet", repo, clone], tmp);
  const patchFile = path.join(tmp, "working.patch");
  writeFileSync(patchFile, bundle.patch);
  gitText(["apply", "--whitespace=nowarn", patchFile], clone);
});

for (const name of ["line\nbinary.bin", "image.bin\r"]) {
  test(`a binary path containing a line break is still detected (${JSON.stringify(name)}, issue #213)`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-newline-"));
    const repo = makeRepo(tmp);
    t.after(() => rmSync(tmp, { recursive: true, force: true }));

    writeFileSync(path.join(repo, name), Buffer.from([0x00, 0x01, 0xff]));
    writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
    commitAll(repo, "newline binary");
    rmSync(path.join(repo, name));
    writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");

    const { bundle } = diffBundle(repo, {});
    assert.deepEqual(bundle.binarySkipped, [name]);
    assert.equal(bundle.patch.includes("\u0000"), false);
  });
}

test("a binary-only change is a bundle with coverage gaps, not a throw (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-binary-only-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "icon.png"), NUL_BYTES);
  commitAll(repo, "icon");
  const baseSha = headSha(repo);
  writeFileSync(path.join(repo, "icon.png"), Buffer.from([0x00, 0x02]));
  commitAll(repo, "new icon");

  const diff = prDiffFromShas(repo, baseSha, headSha(repo));
  assert.equal(diff.patch, "");
  assert.deepEqual(diff.binarySkipped, ["icon.png"]);

  const branch = diffBundle(repo, { localMode: "branch", base: baseSha }).bundle;
  assert.equal(branch.patch, "");
  assert.deepEqual(branch.binarySkipped, ["icon.png"]);

  // Uncommitted mode keeps its existing contract: nothing to review, with
  // the skipped binaries named.
  writeFileSync(path.join(repo, "icon.png"), Buffer.from([0x00, 0x03]));
  assert.throws(() => diffBundle(repo, {}), /No uncommitted changes to review\. Skipped files: icon\.png \(binary\)\./);
});

test("a deletion behind a symlinked parent is not sniffed through the link (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-symlink-parent-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  mkdirSync(path.join(repo, "src"));
  writeFileSync(path.join(repo, "src", "app.ts"), "export const a = 1;\n");
  commitAll(repo, "src");
  // Outside the repo: a same-named file over the size limit, reached only
  // by following the new `src` symlink.
  const outside = path.join(tmp, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "app.ts"), "");
  truncateSync(path.join(outside, "app.ts"), 17 * 1024 * 1024);
  rmSync(path.join(repo, "src"), { recursive: true });
  symlinkSync(outside, path.join(repo, "src"));
  gitText(["add", "-A"], repo);

  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped ?? [], []);
  assert.match(bundle.patch, /^-export const a = 1;$/m);

  const clone = path.join(tmp, "clone");
  gitText(["clone", "--quiet", repo, clone], tmp);
  const patchFile = path.join(tmp, "working.patch");
  writeFileSync(patchFile, bundle.patch);
  gitText(["apply", "--whitespace=nowarn", patchFile], clone);
});

test("an exclusion list too long for one argv still yields the text patch (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-argv-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  commitAll(repo, "base");
  const baseSha = headSha(repo);
  writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");
  commitAll(repo, "head");

  // About 1.5 MB of exclusions: past macOS ARG_MAX (1 MiB) in a single call.
  const excluded = Array.from({ length: 3000 }, (_, i) => `bin/${String(i).padStart(4, "0")}-${"x".repeat(480)}.bin`);
  const patch = reviewDiff(repo, [], [baseSha, headSha(repo)], excluded, ["app.ts", ...excluded]);
  assert.match(patch, /^\+export const a = 2;$/m);
});

test("batched pathspecs keep a file added under a deleted file's path (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-argv-nested-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "old.ts"), "export const o = 1;\n");
  commitAll(repo, "base");
  const baseSha = headSha(repo);
  rmSync(path.join(repo, "old.ts"));
  mkdirSync(path.join(repo, "old.ts"));
  writeFileSync(path.join(repo, "old.ts", "new.ts"), "export const n = eval;\n");
  gitText(["add", "-A"], repo);
  commitAll(repo, "head");

  const excluded = Array.from({ length: 3000 }, (_, i) => `bin/${String(i).padStart(4, "0")}-${"x".repeat(480)}.bin`);
  const patch = reviewDiff(repo, [], [baseSha, headSha(repo)], excluded, ["old.ts", "old.ts/new.ts", ...excluded]);
  assert.match(patch, /^-export const o = 1;$/m);
  assert.match(patch, /^\+export const n = eval;$/m);
});

test("a staged binary with no file on disk (skip-worktree) is skipped, not inlined (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-skip-worktree-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "data.txt"), "plain\n");
  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  commitAll(repo, "base");
  writeFileSync(path.join(repo, "data.txt"), Buffer.from([0x00, 0xff, 0x01]));
  gitText(["add", "data.txt"], repo);
  gitText(["update-index", "--skip-worktree", "data.txt"], repo);
  rmSync(path.join(repo, "data.txt"));
  writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");

  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped, ["data.txt"]);
  assert.equal(bundle.patch.includes("\u0000"), false);
  assert.match(bundle.patch, /^\+export const a = 2;$/m);
});

test("a skip-worktree staged binary behind a directory or symlink is skipped, not inlined (issue #213)", (t) => {
  for (const replacement of ["dir", "symlink", "assume-unchanged-dir"]) {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-skip-worktree-nonfile-"));
    const repo = makeRepo(tmp);
    t.after(() => rmSync(tmp, { recursive: true, force: true }));

    writeFileSync(path.join(repo, "data.txt"), "plain\n");
    writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
    commitAll(repo, "base");
    writeFileSync(path.join(repo, "data.txt"), Buffer.from([0x00, 0xff, 0x01]));
    gitText(["add", "data.txt"], repo);
    gitText(["update-index", replacement === "assume-unchanged-dir" ? "--assume-unchanged" : "--skip-worktree", "data.txt"], repo);
    rmSync(path.join(repo, "data.txt"));
    if (replacement === "symlink") symlinkSync("app.ts", path.join(repo, "data.txt"));
    else mkdirSync(path.join(repo, "data.txt"));
    writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");

    const { bundle } = diffBundle(repo, {});
    assert.deepEqual(bundle.binarySkipped, ["data.txt"], replacement);
    assert.equal(bundle.patch.includes("\u0000"), false, replacement);
    assert.match(bundle.patch, /^\+export const a = 2;$/m, replacement);
  }
});

test("a skip-worktree staged text change is reviewed even if the file on disk is huge (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-skip-worktree-huge-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "data.ts"), "export const d = 1;\n");
  commitAll(repo, "base");
  writeFileSync(path.join(repo, "data.ts"), "export const d = eval;\n");
  gitText(["add", "data.ts"], repo);
  gitText(["update-index", "--skip-worktree", "data.ts"], repo);
  truncateSync(path.join(repo, "data.ts"), 17 * 1024 * 1024);

  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binarySkipped ?? [], []);
  assert.match(bundle.patch, /^\+export const d = eval;$/m);
});

for (const child of ["binary", "oversized"] as const) {
  test(`a binary swapped for a directory of skipped untracked files has nothing to review (${child}, issue #213)`, (t) => {
    const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-swap-skipped-"));
    const repo = makeRepo(tmp);
    t.after(() => rmSync(tmp, { recursive: true, force: true }));

    writeFileSync(path.join(repo, "payload"), NUL_BYTES);
    commitAll(repo, "binary payload");
    rmSync(path.join(repo, "payload"));
    mkdirSync(path.join(repo, "payload"));
    writeFileSync(path.join(repo, "payload", "child"), child === "binary" ? NUL_BYTES : "x".repeat(300 * 1024));

    assert.throws(() => diffBundle(repo, {}), /No uncommitted changes to review\./);
  });
}

test("a PR diff run from a subdirectory still covers the whole repository (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-subdir-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  mkdirSync(path.join(repo, "sub"));
  writeFileSync(path.join(repo, "sub", "keep.md"), "# keep\n");
  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  commitAll(repo, "base");
  const baseSha = headSha(repo);
  writeFileSync(path.join(repo, "app.ts"), "export const a = eval;\n");
  writeFileSync(path.join(repo, "pixel.bin"), NUL_BYTES);
  commitAll(repo, "head");

  const diff = prDiffFromShas(path.join(repo, "sub"), baseSha, headSha(repo));
  assert.deepEqual(diff.binarySkipped, ["pixel.bin"]);
  assert.match(diff.patch, /^\+export const a = eval;$/m);
});

test("inherited pathspec modes cannot turn the binary excludes off (issue #213)", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-gitattr-pathspec-env-"));
  const repo = makeRepo(tmp);
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  commitAll(repo, "base");
  const baseSha = headSha(repo);
  writeFileSync(path.join(repo, "app.ts"), "export const a = eval;\n");
  writeFileSync(path.join(repo, "pixel.bin"), NUL_BYTES);
  commitAll(repo, "head");

  for (const name of ["GIT_LITERAL_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
    const previous = process.env[name];
    process.env[name] = "1";
    try {
      const diff = prDiffFromShas(repo, baseSha, headSha(repo));
      assert.deepEqual(diff.binarySkipped, ["pixel.bin"], name);
      assert.equal(diff.patch.includes("\u0000"), false, name);
      assert.match(diff.patch, /^\+export const a = eval;$/m, name);
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});
