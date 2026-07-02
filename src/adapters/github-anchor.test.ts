import assert from "node:assert/strict";
import test from "node:test";
import { anchorableIn, headLinesInPatch } from "./github";

test("headLinesInPatch collects head ranges across files and hunks", () => {
  const patch = [
    "diff --git a/a.txt b/a.txt",
    "--- a/a.txt",
    "+++ b/a.txt",
    "@@ -1,2 +1,3 @@",
    " ctx",
    "-old",
    "+new1",
    "+new2",
    "@@ -5 +7 @@",
    " ctx",
    "-x",
    "+y",
    "diff --git a/b.txt b/b.txt",
    "--- a/b.txt",
    "+++ b/b.txt",
    "@@ -1 +1,2 @@",
    " ctx",
    "+added",
  ].join("\n");

  const ranges = headLinesInPatch(patch);

  assert.deepEqual(ranges.get("a.txt"), [
    [1, 3],
    [7, 7],
  ]);
  assert.deepEqual(ranges.get("b.txt"), [[1, 2]]);
});

test("anchorableIn respects collected ranges", () => {
  const ranges = new Map<string, Array<[number, number]>>([
    ["a.txt", [[1, 3], [7, 7]]],
    ["b.txt", [[1, 2]]],
  ]);

  assert.equal(anchorableIn(ranges, "a.txt", 1), true);
  assert.equal(anchorableIn(ranges, "a.txt", 3), true);
  assert.equal(anchorableIn(ranges, "a.txt", 7), true);
  assert.equal(anchorableIn(ranges, "a.txt", 4), false);
  assert.equal(anchorableIn(ranges, "b.txt", 2), true);
  assert.equal(anchorableIn(ranges, "b.txt", 3), false);
  assert.equal(anchorableIn(ranges, "missing.txt", 1), false);
});

test("headLinesInPatch handles +c with no count (d defaults to 1)", () => {
  const patch = [
    "diff --git a/x.txt b/x.txt",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -3 +5 @@",
    " ctx",
    "-a",
    "+b",
  ].join("\n");

  const ranges = headLinesInPatch(patch);
  assert.deepEqual(ranges.get("x.txt"), [[5, 5]]);
  assert.equal(anchorableIn(ranges, "x.txt", 5), true);
});

test("headLinesInPatch parses a new file (--/dev/null to b/new)", () => {
  const patch = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,5 @@",
    "+a",
    "+b",
    "+c",
    "+d",
    "+e",
  ].join("\n");

  const ranges = headLinesInPatch(patch);
  assert.deepEqual(ranges.get("new.txt"), [[1, 5]]);
  assert.equal(anchorableIn(ranges, "new.txt", 5), true);
  assert.equal(anchorableIn(ranges, "new.txt", 6), false);
});

test("headLinesInPatch skips deleted files (+++ /dev/null)", () => {
  const patch = [
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
  ].join("\n");

  const ranges = headLinesInPatch(patch);
  assert.equal(ranges.has("gone.txt"), false);
  assert.equal(anchorableIn(ranges, "gone.txt", 1), false);
});

test("headLinesInPatch follows rename headers to the new path", () => {
  const patch = [
    "diff --git a/old.txt b/new.txt",
    "similarity index 80%",
    "rename from old.txt",
    "rename to new.txt",
    "--- a/old.txt",
    "+++ b/new.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");

  const ranges = headLinesInPatch(patch);
  assert.deepEqual(ranges.get("new.txt"), [[1, 1]]);
  assert.equal(ranges.has("old.txt"), false);
});

test("headLinesInPatch returns empty map for empty patch", () => {
  const ranges = headLinesInPatch("");
  assert.equal(ranges.size, 0);
});
