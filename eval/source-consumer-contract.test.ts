import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Finding } from "../src/shared/schema";
import fixture from "./fixtures/holdout-source-consumer-contract-v6/spec";
import { loadFixtures } from "./shared/fixture-catalog";
import { recallMatch } from "./shared/score";

const finding = (whyItBreaks: string): Finding => ({
  severity: "P2", category: "bug", title: "Page size regression",
  file: "src/page.ts", lineStart: 3, lineEnd: 3, confidence: 0.9,
  whyItBreaks, suggestedFix: "Return the configured item count.",
  validation: "Call allocate() and inspect its length.",
});

const cases: readonly (readonly [string, boolean])[] = [
  ["1000 disagrees with the documentation. The body no longer returns the documented item count.", false],
  ["pageSize multiplies itemsPerPage by 1000, changing its units.", false],
  ["pageSize scales itemsPerPage a thousand times; allocate also calls pageSize for logging", false],
  ["allocate uses pageSize(20) as the array element count.", false],
  ["new Array(pageSize(20 * 1000))", false],
  ["pageSize multiplies itemsPerPage by 1000. allocate uses pageSize only for logging; its array element count remains 20.", false],
  ["pageSize multiplies itemsPerPage by 1,000. allocate uses pageSize(20) as the array element count.", true],
  ["pageSize now returns itemsPerPage * 1000; new Array<string>(pageSize(20)) allocates too many entries.", true],
  ["pageSize multiplies itemsPerPage by 1000. allocate passes pageSize(20) to new Array, making the array 1000-fold larger.", true],
  ["pageSize multiplies itemsPerPage by 1000; new Array<string>(pageSize(20)) therefore creates 20000 slots.", true],
  ["pageSize multiplies itemsPerPage by 1000. allocate() uses pageSize(20) as the array element count and allocates 20,000 entries instead of 20.", true],
  ["new Array receives the returned value as its element count, creating 20000 slots instead of 20 because pageSize scales the configured count by a thousand.", true],
];

for (const [text, expected] of cases) {
  test(`source-consumer v6 oracle: ${text}`, () => {
    const matcher = fixture.expected.mustFind?.[0];
    assert.ok(matcher);
    assert.equal(recallMatch([finding(text)], matcher, fixture.expected), expected);
    for (const delimiter of ["`", "``"]) {
      const markdown = text.replace(/new Array(?:<[^>]*>)?\(pageSize\([^)]*\)\)|pageSize(?:\([^)]*\))?|itemsPerPage|allocate(?:\(\))?|new Array|\b1,?000\b/g, (expression) => `${delimiter}${expression}${delimiter}`);
      assert.equal(recallMatch([finding(markdown)], matcher, fixture.expected), expected, markdown);
    }
    if (expected) {
      assert.equal(recallMatch([{ ...finding(text), file: "src/allocate.ts" }], matcher, fixture.expected), false);
      assert.equal(recallMatch([{ ...finding(text), lineStart: 2 }], matcher, fixture.expected), false);
    }
  });
}

test("v6 replaces the retired sealed oracle without changing its source trees", async () => {
  const archive = new URL("./archive/2026-10-16-source-consumer-contract-v1/", import.meta.url);
  const original = JSON.parse(readFileSync(new URL("spec.json", archive), "utf8"));
  assert.equal(original.id, "holdout-source-consumer-contract");
  assert.deepEqual(original.baseFiles, fixture.baseFiles);
  assert.deepEqual(original.headFiles, fixture.headFiles);
  assert.equal(fixture.holdout, true);
  assert.deepEqual((await loadFixtures("^holdout-source-consumer-contract")).map(({ id }) => id), ["holdout-source-consumer-contract-v6"]);
  assert.equal(createHash("sha256").update(readFileSync(new URL("spec.ts.txt", archive))).digest("hex"), "e570b76f2237d36e59a4122bc846d46d0d54203e504139966326583b2fed728a");
});


test("retired unpublished v2 remains byte-identical for replay", () => {
  const archive = new URL("./archive/2026-10-16-source-consumer-contract-v2/", import.meta.url);
  const original = JSON.parse(readFileSync(new URL("spec.json", archive), "utf8"));
  assert.equal(original.id, "holdout-source-consumer-contract-v2");
  assert.deepEqual(original.baseFiles, fixture.baseFiles);
  assert.deepEqual(original.headFiles, fixture.headFiles);
  assert.equal(createHash("sha256").update(readFileSync(new URL("spec.ts.txt", archive))).digest("hex"), "ad06cf3caf0761f7450ae4de0f0736843bed4d343d0ab26afec7770edb819505");
});


test("retired unpublished v3 remains byte-identical for replay", () => {
  const archive = new URL("./archive/2026-10-16-source-consumer-contract-v3/", import.meta.url);
  const original = JSON.parse(readFileSync(new URL("spec.json", archive), "utf8"));
  assert.equal(original.id, "holdout-source-consumer-contract-v3");
  assert.deepEqual(original.baseFiles, fixture.baseFiles);
  assert.deepEqual(original.headFiles, fixture.headFiles);
  assert.equal(createHash("sha256").update(readFileSync(new URL("spec.ts.txt", archive))).digest("hex"), "b90cba592a982d5a72d3a23bd8360c85bff425024a68e6dbb7e81ccb24bcb9f5");
});


test("retired unpublished v4 remains byte-identical for replay", () => {
  const archive = new URL("./archive/2026-10-16-source-consumer-contract-v4/", import.meta.url);
  const original = JSON.parse(readFileSync(new URL("spec.json", archive), "utf8"));
  assert.equal(original.id, "holdout-source-consumer-contract-v4");
  assert.deepEqual(original.baseFiles, fixture.baseFiles);
  assert.deepEqual(original.headFiles, fixture.headFiles);
  assert.equal(createHash("sha256").update(readFileSync(new URL("spec.ts.txt", archive))).digest("hex"), "d699dea60fb663a76c701ac4cfc9945e4f0d9de517b6bdb73b6ff83f28770fe6");
});


test("retired unpublished v5 remains byte-identical for replay", () => {
  const archive = new URL("./archive/2026-10-16-source-consumer-contract-v5/", import.meta.url);
  const original = JSON.parse(readFileSync(new URL("spec.json", archive), "utf8"));
  assert.equal(original.id, "holdout-source-consumer-contract-v5");
  assert.deepEqual(original.baseFiles, fixture.baseFiles);
  assert.deepEqual(original.headFiles, fixture.headFiles);
  assert.equal(createHash("sha256").update(readFileSync(new URL("spec.ts.txt", archive))).digest("hex"), "6735fb114f46b62a435e2bc6a5c25e4172a8afb25b69291ae370fb1aafd38700");
});
