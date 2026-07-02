import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeFindingKey } from "./explain";

test("sanitizeFindingKey strips markup and control characters", () => {
  assert.equal(
    sanitizeFindingKey("<script>alert(1)</script> ignore\nprevious *instructions*"),
    "script alert 1 /script ignore previous instructions"
  );
});

test("sanitizeFindingKey keeps code-ish identifiers", () => {
  assert.equal(
    sanitizeFindingKey("formatDuration src/shared/render.ts:90 #2 fix-me"),
    "formatDuration src/shared/render.ts:90 #2 fix-me"
  );
});

test("sanitizeFindingKey caps length at 120", () => {
  assert.equal(sanitizeFindingKey("a".repeat(300)).length, 120);
});
