import assert from "node:assert/strict";
import test from "node:test";
import { WITHHELD_MESSAGE } from "../shared/outbound-screen.js";
import { screenExplanation } from "./explain.js";

const KNOWN = "abc123def456ghi789jkl0";

test("screenExplanation withholds an explanation carrying a runner credential value", () => {
  assert.throws(
    () => screenExplanation(`the key is ${KNOWN}`, { FAKE_API_KEY: KNOWN }),
    (err: unknown) => err instanceof Error && err.message === WITHHELD_MESSAGE && !err.message.includes(KNOWN),
  );
});

test("screenExplanation redacts a credential-shaped string and keeps the rest", () => {
  const token = `ghp_${"a1".repeat(18)}`;
  const out = screenExplanation(`see ${token} here`, {});
  assert.equal(out, "see [redacted] here");
});

test("screenExplanation returns clean text unchanged", () => {
  assert.equal(screenExplanation("plain explanation", {}), "plain explanation");
});
