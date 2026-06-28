import assert from "node:assert/strict";
import test from "node:test";
import { deriveVerdict } from "./verdict";
import type { Finding } from "../shared/schema";

const finding: Finding = {
  severity: "P2",
  title: "Blocks submit",
  category: "bug",
  file: "src/app.ts",
  lineStart: 1,
  lineEnd: 1,
  confidence: 0.9,
  whyItBreaks: "The submit path is blocked.",
  suggestedFix: "Allow the valid path.",
  validation: "pnpm test",
};

test("deriveVerdict requests changes for blocking findings", () => {
  const verdict = deriveVerdict([finding], []);

  assert.equal(verdict, "changes_requested");
});

test("deriveVerdict needs human when only residual risk blocks", () => {
  const verdict = deriveVerdict([], [{ text: "deep pass failed", blocks: true }]);

  assert.equal(verdict, "needs_human");
});

test("deriveVerdict passes when no blocking evidence remains", () => {
  const verdict = deriveVerdict([], [{ text: "low confidence area", blocks: false }]);

  assert.equal(verdict, "pass");
});
