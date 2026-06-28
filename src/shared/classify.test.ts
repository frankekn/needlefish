import assert from "node:assert/strict";
import test from "node:test";
import { classifySurface } from "./classify";

test("classifySurface identifies high-risk repo surfaces", () => {
  assert.equal(classifySurface(".github/workflows/review.yml"), "workflow");
  assert.equal(classifySurface("package.json"), "dependency");
  assert.equal(classifySurface("docs/usage.md"), "docs");
  assert.equal(classifySurface("src/api/users.ts"), "public-api");
  assert.equal(classifySurface("src/core/review.ts"), "source");
});
