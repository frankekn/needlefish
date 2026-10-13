// Issue #213: a PR that adds a `.gitattributes` line such as `* -diff` or
// `* binary` used to hide every hunk from the review patch, because git
// applied the head-commit attributes to `git diff <base> <head>`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { prDiffFromShas } from "../shared/repo.js";
import { touchesSincePrevHead } from "./github.js";
import { diffBundle } from "./local.js";

const NUL_BYTES = Buffer.from([0x89, 0x00, 0x50, 0x4e, 0x47]);

function makeRepo(t: test.TestContext, name: string): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), `needlefish-gitattr-${name}-`));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
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
  writeFileSync(path.join(repo, "pixel.bin"), Buffer.from([0x89, 0x00, 0x50, 0x01]));
  commitAll(repo, "hide with .gitattributes");
  return { baseSha, headSha: headSha(repo) };
}

test("branch-mode bundle shows real hunks through `* -diff` (issue #213)", (t) => {
  const repo = makeRepo(t, "nodiff");
  const { baseSha } = attributeHead(repo, "* -diff\n");

  const { bundle } = diffBundle(repo, { localMode: "branch", base: baseSha });

  assert.match(bundle.patch, /^\+export const a = eval\(process\.env\.X!\);$/m);
  assert.match(bundle.patch, /^\+\* -diff$/m);
  assert.match(bundle.patch, /^Binary files \/dev\/null and b\/pixel\.bin differ$/m);
  assert.equal(bundle.patch.includes("\0"), false);
});

test("committed-range diff shows real hunks through `* binary` (issue #213)", (t) => {
  const repo = makeRepo(t, "binary");
  const { baseSha, headSha: head } = attributeHead(repo, "* binary\n");

  const diff = prDiffFromShas(repo, baseSha, head);

  assert.match(diff.patch, /^\+export const a = eval\(process\.env\.X!\);$/m);
  assert.match(diff.patch, /^Binary files \/dev\/null and b\/pixel\.bin differ$/m);
  assert.match(diff.patchStat, /app\.ts +\| +1 \+$/m);
  assert.equal(diff.patch.includes("\0"), false);
});

test("textconv attributes cannot rewrite patch content (issue #213)", (t) => {
  const repo = makeRepo(t, "textconv");
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

test("re-review history diff keeps source touches through `* -diff` (issue #213)", (t) => {
  const repo = makeRepo(t, "history");
  writeFileSync(path.join(repo, "app.ts"), "export const a = 1;\n");
  commitAll(repo, "prev");
  const prevHead = headSha(repo);
  writeFileSync(path.join(repo, ".gitattributes"), "* -diff\n");
  writeFileSync(path.join(repo, "app.ts"), "export const a = 2;\n");
  commitAll(repo, "head");

  const touches = touchesSincePrevHead(repo, prevHead, headSha(repo));
  assert.ok(touches?.get("app.ts"));
});

test("a binary with a non-UTF-8 name never puts raw bytes in the patch (issue #213)", (t) => {
  const repo = makeRepo(t, "badname");
  const baseSha = headSha(repo);
  // Staged through the index: macOS file systems reject non-UTF-8 names.
  const blob = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd: repo, input: NUL_BYTES, encoding: "utf8" }).stdout.trim();
  const entry = Buffer.concat([Buffer.from(`100644 ${blob}\t`), Buffer.from("bad-\xff.bin", "latin1"), Buffer.from("\0")]);
  assert.equal(spawnSync("git", ["update-index", "-z", "--index-info"], { cwd: repo, input: entry }).status, 0);
  gitText(["-c", "user.name=Needlefish Test", "-c", "user.email=needlefish-test@example.invalid", "commit", "-qm", "binary with a non-UTF-8 name"], repo);

  const diff = prDiffFromShas(repo, baseSha, headSha(repo));

  assert.match(diff.patch, /^Binary files \/dev\/null and .* differ$/m);
  assert.equal(diff.patch.includes("\0"), false);
});

test("an uncommitted working-tree-encoding attribute still converts the text it adds (issue #213)", (t) => {
  const repo = makeRepo(t, "wte");
  writeFileSync(path.join(repo, ".gitattributes"), "*.ps1 working-tree-encoding=UTF-16LE\n");
  writeFileSync(path.join(repo, "script.ps1"), Buffer.from("Write-Host old\n", "utf16le"));
  gitText(["add", ".gitattributes", "script.ps1"], repo);
  writeFileSync(path.join(repo, "script.ps1"), Buffer.from("Write-Host new\n", "utf16le"));

  const { bundle } = diffBundle(repo, {});
  assert.match(bundle.patch, /^\+Write-Host new$/m);
});

test("untracked files are diffed without attributes or filters (issue #213)", (t) => {
  const repo = makeRepo(t, "untracked");
  writeFileSync(path.join(repo, ".gitattributes"), "*.ts -diff\n*.txt filter=nul\n");
  gitText(["config", "filter.nul.clean", "printf 'a\\\\000b\\\\n'"], repo);
  commitAll(repo, "attributes");
  writeFileSync(path.join(repo, "new.ts"), "export const b = eval(y);\n");
  writeFileSync(path.join(repo, "x.txt"), "plain text\n");

  const { bundle } = diffBundle(repo, {});

  assert.match(bundle.patch, /^\+export const b = eval\(y\);$/m);
  assert.match(bundle.patch, /^\+plain text$/m);
  assert.equal(bundle.patch.includes("\0"), false);
});
