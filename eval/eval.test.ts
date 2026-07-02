import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Verdict } from "../src/shared/schema";
import { parseArgs } from "./run";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { matchesSpec, score } from "./shared/score";
import type { Expected } from "./shared/types";
import posOverBlock from "./fixtures/pos-over-block/spec";
import negStyleOnly from "./fixtures/neg-style-only/spec";

function finding(partial: Partial<Finding> & Pick<Finding, "title" | "whyItBreaks" | "file" | "lineStart">): Finding {
  return {
    severity: "P2",
    category: "bug",
    lineEnd: partial.lineStart,
    confidence: 0.8,
    suggestedFix: "",
    validation: "",
    ...partial,
  };
}

test("loadFixture materializes a git repo and builds a bundle with the defect diff", () => {
  const loaded = loadFixture(posOverBlock);
  try {
    assert.notEqual(loaded.bundle.baseSha, loaded.bundle.headSha);
    assert.ok(loaded.bundle.patch.includes('req.role === "viewer"'), "patch must contain the over-block guard");
    assert.ok(loaded.bundle.changedFiles.some((f) => f.path === "src/handler.ts"));
    assert.equal(loaded.bundle.deep, false);
  } finally {
    loaded.cleanup();
  }
});

test("promptHash is stable across calls", () => {
  assert.equal(promptHash(), promptHash());
  assert.match(promptHash(), /^[0-9a-f]{16}$/);
});

test("matchesSpec: regex against title + whyItBreaks, optional category", () => {
  const f = finding({ title: "viewer branch is unreachable", whyItBreaks: "isEligible rejects viewers", file: "src/handler.ts", lineStart: 18 });
  assert.ok(matchesSpec(f, { pattern: "viewer|unreachable" }));
  assert.ok(matchesSpec(f, { pattern: "viewer", category: "bug" }));
  assert.ok(!matchesSpec(f, { pattern: "viewer", category: "security" }));
  assert.ok(!matchesSpec(f, { pattern: "nomatch" }));
});

test("score: positive fixture with a matching anchored finding passes recall + anchor", () => {
  const loaded = loadFixture(posOverBlock);
  try {
    const expected = posOverBlock.expected;
    const result = {
      verdict: "changes_requested" as Verdict,
      findings: [
        finding({ title: "over-block: isEligible rejects viewers", whyItBreaks: "the viewer read-only branch in handle is now unreachable", file: "src/handler.ts", lineStart: 18 }),
      ],
    };
    const s = score(result, expected, posOverBlock.id);
    assert.equal(s.formatOk, true);
    assert.equal(s.verdictMatch, true);
    assert.equal(s.recall, true);
    assert.equal(s.lineAnchorValid, true);
    assert.equal(s.falsePositive, false);
  } finally {
    loaded.cleanup();
  }
});

test("score: positive fixture with no matching finding fails recall", () => {
  const expected: Expected = posOverBlock.expected;
  const result = {
    verdict: "pass" as Verdict,
    findings: [finding({ title: "unrelated nit", whyItBreaks: "style", file: "src/handler.ts", lineStart: 1 })],
  };
  const s = score(result, expected, posOverBlock.id);
  assert.equal(s.recall, false);
  assert.equal(s.verdictMatch, false);
  assert.equal(s.mustFindHits, 0);
});

test("score: negative fixture with a blocking finding is a false positive", () => {
  const expected: Expected = negStyleOnly.expected;
  const result = {
    verdict: "changes_requested" as Verdict,
    findings: [finding({ title: "rename is risky", whyItBreaks: "name changed", file: "src/format.ts", lineStart: 2, severity: "P2" })],
  };
  const s = score(result, expected, negStyleOnly.id);
  assert.equal(s.falsePositive, true);
  assert.equal(s.verdictMatch, false);
});

test("score: negative fixture with only P3 is not a false positive", () => {
  const expected: Expected = negStyleOnly.expected;
  const result = {
    verdict: "pass" as Verdict,
    findings: [finding({ title: "minor nit", whyItBreaks: "style", file: "src/format.ts", lineStart: 2, severity: "P3" })],
  };
  const s = score(result, expected, negStyleOnly.id);
  assert.equal(s.falsePositive, false);
  assert.equal(s.verdictMatch, true);
});

test("score: null result (review failed) is formatOk=false", () => {
  const s = score(null, posOverBlock.expected, posOverBlock.id, "runner exited 1");
  assert.equal(s.formatOk, false);
  assert.equal(s.recall, false);
  assert.equal(s.error, "runner exited 1");
});

test("parseArgs: collects --env KEY=VALUE overrides", () => {
  const args = parseArgs(["--runner", "codex", "--env", "NEEDLEFISH_LARGE_PATCH_CHARS=80000", "--env", "NEEDLEFISH_DEEP_CONCURRENCY=1"]);
  assert.deepEqual(args.env, {
    NEEDLEFISH_LARGE_PATCH_CHARS: "80000",
    NEEDLEFISH_DEEP_CONCURRENCY: "1",
  });
});

test("parseArgs: later --env overrides the same key", () => {
  const args = parseArgs(["--env", "FOO=1", "--env", "FOO=2"]);
  assert.deepEqual(args.env, { FOO: "2" });
});

test("parseArgs: rejects malformed --env values", () => {
  assert.throws(() => parseArgs(["--env"]), /--env requires KEY=VALUE/);
  assert.throws(() => parseArgs(["--env", "NOEQUALS"]), /--env requires KEY=VALUE, got: NOEQUALS/);
  assert.throws(() => parseArgs(["--env", "=value"]), /--env requires KEY=VALUE, got: =value/);
});
