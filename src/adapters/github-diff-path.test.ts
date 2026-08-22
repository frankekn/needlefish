import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { commitAll, initRepo } from "../shared/codex-runner-test-fixtures";
import { anchorableIn, headLinesInPatch, unquoteGitCStyle } from "./github";

test("unquoteGitCStyle decodes named escapes and leaves trailing junk after the close quote", () => {
  assert.equal(unquoteGitCStyle('"plain"'), "plain");
  assert.equal(unquoteGitCStyle('"a\\\\b"'), "a\\b");
  assert.equal(unquoteGitCStyle('"a\\"b"'), 'a"b');
  assert.equal(unquoteGitCStyle('"a\\nb"'), "a\nb");
  assert.equal(unquoteGitCStyle('"a\\tb"'), "a\tb");
  assert.equal(unquoteGitCStyle('"a\\rb"'), "a\rb");
  assert.equal(unquoteGitCStyle('"a\\bb"'), "a\bb");
  assert.equal(unquoteGitCStyle('"a\\fb"'), "a\fb");
  assert.equal(unquoteGitCStyle('"a\\vb"'), "a\vb");
  assert.equal(unquoteGitCStyle('"a\\ab"'), "a\x07b");
  assert.equal(unquoteGitCStyle('"b/foo"\tSat Jan 1 00:00:00 2024 +0000'), "b/foo");
});

test("unquoteGitCStyle decodes octal escapes as UTF-8 bytes, not code points", () => {
  // 測 U+6E2C = e6 b8 ac; 試 U+8A66 = e8 a9 a6. Independent-code-point
  // decoding of \346\270\254 would be mojibake, not 測.
  assert.equal(unquoteGitCStyle('"b/src/\\346\\270\\254\\350\\251\\246.ts"'), "b/src/測試.ts");
  assert.notEqual(unquoteGitCStyle('"\\346\\270\\254"'), "\u0146\u00b8\u00ac");
});

test("unquoteGitCStyle rejects malformed quoting", () => {
  assert.equal(unquoteGitCStyle("plain"), null);
  assert.equal(unquoteGitCStyle('"unterminated'), null);
  assert.equal(unquoteGitCStyle('"\\x"'), null);
  assert.equal(unquoteGitCStyle('"\\400"'), null);
  assert.equal(unquoteGitCStyle('"\\34"'), null);
  assert.equal(unquoteGitCStyle(""), null);
});

test("headLinesInPatch strips a trailing tab from an unquoted +++ path", () => {
  const patch = [
    "diff --git a/src/has space.ts b/src/has space.ts",
    "--- a/src/has space.ts",
    "+++ b/src/has space.ts\t",
    "@@ -0,0 +1 @@",
    "+x",
    "diff --git a/ordinary.ts b/ordinary.ts",
    "--- a/ordinary.ts",
    "+++ b/ordinary.ts\t2024-01-01 00:00:00.000000000 +0000",
    "@@ -0,0 +1 @@",
    "+y",
  ].join("\n");
  const ranges = headLinesInPatch(patch);
  assert.deepEqual(ranges.get("src/has space.ts"), [[1, 1]]);
  assert.equal(ranges.has("src/has space.ts\t"), false);
  assert.equal(anchorableIn(ranges, "src/has space.ts", 1), true);
  assert.deepEqual(ranges.get("ordinary.ts"), [[1, 1]]);
  assert.equal(anchorableIn(ranges, "ordinary.ts", 1), true);
});

test("headLinesInPatch anchors a handwritten C-quoted CJK +++ header", () => {
  const patch = [
    'diff --git "a/src/\\346\\270\\254\\350\\251\\246.ts" "b/src/\\346\\270\\254\\350\\251\\246.ts"',
    "new file mode 100644",
    "--- /dev/null",
    '+++ "b/src/\\346\\270\\254\\350\\251\\246.ts"',
    "@@ -0,0 +1 @@",
    "+x",
  ].join("\n");
  const ranges = headLinesInPatch(patch);
  assert.deepEqual(ranges.get("src/測試.ts"), [[1, 1]]);
  assert.equal(anchorableIn(ranges, "src/測試.ts", 1), true);
});

function runGit(repo: string, args: readonly string[]): Buffer {
  const result = spawnSync("git", [...args], { cwd: repo, encoding: "buffer" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${(result.stderr ?? Buffer.alloc(0)).toString("utf8")}`,
    );
  }
  return result.stdout ?? Buffer.alloc(0);
}

function plusPlusPlusHeaders(diff: Buffer): Buffer[] {
  const headers: Buffer[] = [];
  let start = 0;
  for (let i = 0; i <= diff.length; i++) {
    if (i !== diff.length && diff[i] !== 0x0a) continue;
    const line = diff.subarray(start, i);
    if (line.length >= 4 && line.subarray(0, 4).equals(Buffer.from("+++ "))) {
      headers.push(Buffer.from(line));
    }
    start = i + 1;
  }
  return headers;
}

test("headLinesInPatch parses real git-generated headers for hostile names", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-diff-path-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repo = initRepo(tmp);
  mkdirSync(path.join(repo, "src"));

  const files: ReadonlyArray<{ name: string; body: string }> = [
    { name: "src/has space.ts", body: "space-a\nspace-b\n" },
    { name: "src/has\ttab.ts", body: "tab-a\ntab-b\n" },
    { name: 'src/has"quote.ts', body: "quote-a\nquote-b\n" },
    { name: "src/has\\slash.ts", body: "slash-a\nslash-b\n" },
    { name: "src/測試.ts", body: "cjk-a\ncjk-b\ncjk-c\n" },
    { name: "src/測 space.ts", body: "mix-a\nmix-b\n" },
  ];
  for (const file of files) {
    writeFileSync(path.join(repo, file.name), file.body);
  }
  commitAll(repo, "hostile names");

  const diff = runGit(repo, ["diff", "HEAD~1", "HEAD"]);
  const patch = diff.toString("utf8");
  const ranges = headLinesInPatch(patch);

  assert.deepEqual(ranges.get("src/has space.ts"), [[1, 2]]);
  assert.deepEqual(ranges.get("src/has\ttab.ts"), [[1, 2]]);
  assert.deepEqual(ranges.get('src/has"quote.ts'), [[1, 2]]);
  assert.deepEqual(ranges.get("src/has\\slash.ts"), [[1, 2]]);
  assert.deepEqual(ranges.get("src/測試.ts"), [[1, 3]]);
  assert.deepEqual(ranges.get("src/測 space.ts"), [[1, 2]]);

  for (const file of files) {
    assert.equal(anchorableIn(ranges, file.name, 1), true);
  }
  for (const key of ranges.keys()) {
    assert.equal(key.startsWith('"'), false, `leftover quotes in ${key}`);
    assert.doesNotMatch(key, /\\[0-7]{3}/, `leftover octal escape in ${key}`);
  }

  const headers = plusPlusPlusHeaders(diff);
  const cjkHeader = headers.find((line) => {
    const text = line.toString("utf8");
    return text.includes("\\346\\270\\254\\350\\251\\246") || /b\/src\/測試\.ts/.test(text);
  });
  assert.ok(cjkHeader, "expected a +++ header for the CJK file");
  // Default core.quotepath quotes non-ASCII as octal; either form is git's.
  assert.match(
    cjkHeader.toString("utf8"),
    /\+\+\+ "b\/src\/\\346\\270\\254\\350\\251\\246\.ts"|\+\+\+ b\/src\/測試\.ts/,
  );
});

test("headLinesInPatch skips a real git deleted-file header", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-diff-path-del-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "gone.txt"), "bye\n");
  commitAll(repo, "add gone");
  runGit(repo, ["rm", "-q", "gone.txt"]);
  commitAll(repo, "delete gone");

  const patch = runGit(repo, ["diff", "HEAD~1", "HEAD"]).toString("utf8");
  assert.match(patch, /^\+\+\+ \/dev\/null$/m);
  const ranges = headLinesInPatch(patch);
  assert.equal(ranges.has("gone.txt"), false);
  assert.equal(anchorableIn(ranges, "gone.txt", 1), false);
});

test("headLinesInPatch uses the head-side path from a real git rename", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-diff-path-mv-"));
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "old.txt"), "old\n");
  commitAll(repo, "add old");
  runGit(repo, ["mv", "old.txt", "new.txt"]);
  writeFileSync(path.join(repo, "new.txt"), "old\nnew\n");
  commitAll(repo, "rename and edit");

  const patch = runGit(repo, ["diff", "HEAD~1", "HEAD"]).toString("utf8");
  assert.match(patch, /^rename from old\.txt$/m);
  assert.match(patch, /^rename to new\.txt$/m);
  const ranges = headLinesInPatch(patch);
  assert.deepEqual(ranges.get("new.txt"), [[1, 2]]);
  assert.equal(ranges.has("old.txt"), false);
  assert.equal(anchorableIn(ranges, "new.txt", 2), true);
});
