import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildSpecSource,
  checkCaps,
  checkOverwrite,
  deriveSlug,
  isBinaryContent,
  mapKind,
  parseCliArgs,
} from "./pr2fixture";

test("parseCliArgs: valid full invocation parses correctly", () => {
  const args = parseCliArgs([
    "--repo", "owner/name",
    "--pr", "1234",
    "--out", "eval/fixtures-real/my-slug/",
    "--kind", "review-finding",
  ]);
  assert.deepEqual(args, { repo: "owner/name", pr: 1234, out: "eval/fixtures-real/my-slug/", kind: "review-finding", force: false });
});

test("parseCliArgs: --force is captured", () => {
  const args = parseCliArgs(["--repo", "o/n", "--pr", "1", "--out", "eval/fixtures-real/x/", "--kind", "clean-negative", "--force"]);
  assert.equal((args as { force: boolean }).force, true);
});

test("parseCliArgs: --help returns { help: true } without other flags", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
});

test("parseCliArgs: missing --repo throws", () => {
  assert.throws(() => parseCliArgs(["--pr", "1", "--out", "x", "--kind", "revert"]), /--repo is required/);
});

test("parseCliArgs: missing --pr throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--out", "x", "--kind", "revert"]), /--pr is required/);
});

test("parseCliArgs: missing --out throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "1", "--kind", "revert"]), /--out is required/);
});

test("parseCliArgs: missing --kind throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "1", "--out", "x"]), /--kind is required/);
});

test("parseCliArgs: non-numeric --pr throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "abc", "--out", "x", "--kind", "revert"]), /--pr must be a positive integer/);
});

test("parseCliArgs: non-positive --pr throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "0", "--out", "x", "--kind", "revert"]), /--pr must be a positive integer/);
});

test("parseCliArgs: invalid --kind throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "1", "--out", "x", "--kind", "nonsense"]), /--kind must be one of/);
});

test("deriveSlug: extracts kebab-case slug, trailing slash tolerated", () => {
  assert.equal(deriveSlug("eval/fixtures-real/my-slug/"), "my-slug");
  assert.equal(deriveSlug("eval/fixtures-real/my-slug"), "my-slug");
});

test("deriveSlug: rejects uppercase, underscores, leading hyphen", () => {
  assert.throws(() => deriveSlug("eval/fixtures-real/MySlug/"), /kebab-case/);
  assert.throws(() => deriveSlug("eval/fixtures-real/my_slug/"), /kebab-case/);
  assert.throws(() => deriveSlug("eval/fixtures-real/-my-slug/"), /kebab-case/);
});

test("mapKind: clean-negative maps to negative, everything else to positive", () => {
  assert.equal(mapKind("clean-negative"), "negative");
  assert.equal(mapKind("review-finding"), "positive");
  assert.equal(mapKind("post-merge-fix"), "positive");
  assert.equal(mapKind("revert"), "positive");
});

test("checkCaps: a file over the per-file cap fails, names the file", () => {
  const result = checkCaps([{ path: "src/big.ts", bytes: 51 * 1024 }]);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /src\/big\.ts/);
});

test("checkCaps: total over the cap fails even with small individual files", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, bytes: 45 * 1024 }));
  const result = checkCaps(files);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /total/);
});

test("checkCaps: files under both caps pass", () => {
  const result = checkCaps([{ path: "a.ts", bytes: 1024 }, { path: "b.ts", bytes: 2048 }]);
  assert.equal(result.ok, true);
});

test("checkOverwrite: throws when spec.ts exists and force is false", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-test-"));
  try {
    writeFileSync(path.join(tmp, "spec.ts"), "x");
    assert.throws(() => checkOverwrite(tmp, false), /already exists/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkOverwrite: no-op when force is true", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-test-"));
  try {
    writeFileSync(path.join(tmp, "spec.ts"), "x");
    assert.doesNotThrow(() => checkOverwrite(tmp, true));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkOverwrite: no-op when the directory doesn't exist yet", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-test-"));
  rmSync(tmp, { recursive: true, force: true });
  assert.doesNotThrow(() => checkOverwrite(tmp, false));
});

test("isBinaryContent: NUL byte detected as binary", () => {
  assert.equal(isBinaryContent(Buffer.from([0x48, 0x69, 0x00, 0x21])), true);
});

test("isBinaryContent: plain utf8 text is not binary", () => {
  assert.equal(isBinaryContent(Buffer.from("hello world\n", "utf8")), false);
});

test("buildSpecSource: positive skeleton contains placeholder pattern and curator header", () => {
  const src = buildSpecSource({
    id: "my-slug",
    kind: "positive",
    provenance: { repo: "owner/name", pr: 42, kind: "review-finding", evidenceUrl: "https://example.com/pr/42" },
    prTitle: "Fix the thing",
    prUrl: "https://example.com/pr/42",
    baseFiles: { "src/a.ts": "old" },
    headFiles: { "src/a.ts": "new" },
  });
  assert.match(src, /kind: "positive"/);
  assert.match(src, /TODO-CURATOR-PATTERN/);
  assert.match(src, /GENERATED SKELETON/);
  assert.match(src, /provenance: \{ repo: "owner\/name", pr: 42, kind: "review-finding"/);
});

test("buildSpecSource: negative skeleton has noBlockingFindings, no curator pattern placeholder", () => {
  const src = buildSpecSource({
    id: "my-clean-slug",
    kind: "negative",
    provenance: { repo: "owner/name", pr: 7, kind: "clean-negative" },
    prTitle: "Safe refactor",
    prUrl: "https://example.com/pr/7",
    baseFiles: {},
    headFiles: {},
  });
  assert.match(src, /kind: "negative"/);
  assert.match(src, /noBlockingFindings: true/);
  assert.ok(!src.includes("TODO-CURATOR-PATTERN"));
});
