import { test } from "node:test";
import assert from "node:assert/strict";
import type { Finding, Verdict } from "../src/shared/schema";
import { mapLimit, parseArgs, filterByHoldout } from "./run";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { matchesSpec, score } from "./shared/score";
import type { Expected, FixtureSpec } from "./shared/types";
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
  const args = parseArgs(["--runner", "acp", "--env", "NEEDLEFISH_LARGE_PATCH_CHARS=80000", "--env", "NEEDLEFISH_DEEP_CONCURRENCY=1"]);
  assert.equal(args.runner, "acp");
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

test("parseArgs: --concurrency defaults to 4", () => {
  assert.equal(parseArgs([]).concurrency, 4);
});

test("parseArgs: accepts valid --concurrency", () => {
  assert.equal(parseArgs(["--concurrency", "1"]).concurrency, 1);
  assert.equal(parseArgs(["--concurrency", "8"]).concurrency, 8);
});

test("parseArgs: rejects invalid --concurrency", () => {
  assert.throws(() => parseArgs(["--concurrency"]), /--concurrency must be a positive integer/);
  assert.throws(() => parseArgs(["--concurrency", "0"]), /--concurrency must be a positive integer/);
  assert.throws(() => parseArgs(["--concurrency", "1.5"]), /--concurrency must be a positive integer/);
});

test("mapLimit: preserves result order regardless of completion order", async () => {
  const out = await mapLimit([40, 10, 30, 20], 2, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, n));
    return n * 2;
  });
  assert.deepEqual(out, [80, 20, 60, 40]);
});

test("parseArgs: --holdout defaults to include", () => {
  assert.equal(parseArgs([]).holdout, "include");
});

test("parseArgs: accepts valid --holdout modes", () => {
  assert.equal(parseArgs(["--holdout", "include"]).holdout, "include");
  assert.equal(parseArgs(["--holdout", "exclude"]).holdout, "exclude");
  assert.equal(parseArgs(["--holdout", "only"]).holdout, "only");
});

test("parseArgs: rejects invalid --holdout", () => {
  assert.throws(() => parseArgs(["--holdout", "nope"]), /--holdout must be include\|exclude\|only/);
});

function holdoutSpec(id: string, holdout: boolean): FixtureSpec {
  return {
    id,
    kind: "positive",
    defectClass: "test",
    description: "test",
    baseFiles: {},
    headFiles: {},
    expected: { verdict: "pass", mustFind: [{ pattern: "x" }] },
    ...(holdout ? { holdout: true } : {}),
  };
}

test("filterByHoldout: include keeps everything, preserves order", () => {
  const specs = [holdoutSpec("a", false), holdoutSpec("h1", true), holdoutSpec("b", false), holdoutSpec("h2", true)];
  assert.deepEqual(filterByHoldout(specs, "include").map((s) => s.id), ["a", "h1", "b", "h2"]);
});

test("filterByHoldout: exclude drops holdouts", () => {
  const specs = [holdoutSpec("a", false), holdoutSpec("h1", true), holdoutSpec("b", false), holdoutSpec("h2", true)];
  assert.deepEqual(filterByHoldout(specs, "exclude").map((s) => s.id), ["a", "b"]);
});

test("filterByHoldout: only keeps holdouts", () => {
  const specs = [holdoutSpec("a", false), holdoutSpec("h1", true), holdoutSpec("b", false), holdoutSpec("h2", true)];
  assert.deepEqual(filterByHoldout(specs, "only").map((s) => s.id), ["h1", "h2"]);
});

// --- Golden tests for the strict scorer. These encode the anti-gaming
// contract: if a change makes any of these pass with weaker matching, the
// scorer has been gamed, not improved.

test("score: keyword hit on the wrong file does NOT count as recall, even with an anchored unrelated finding", () => {
  const expected: Expected = {
    verdict: "changes_requested",
    mustFind: [{ pattern: "viewer" }],
    anchorFile: "src/handler.ts",
    anchorLineRange: [16, 21],
  };
  const result = {
    verdict: "changes_requested" as Verdict,
    findings: [
      // pattern words, wrong file
      finding({ title: "viewer logic looks wrong", whyItBreaks: "viewer path", file: "src/other.ts", lineStart: 3 }),
      // right file + range, no pattern
      finding({ title: "style nit", whyItBreaks: "naming", file: "src/handler.ts", lineStart: 18 }),
    ],
  };
  const s = score(result, expected, "strict-recall");
  assert.equal(s.recall, false, "pattern and anchor satisfied by different findings must not score");
  assert.equal(s.lineAnchorValid, false);
});

test("score: single finding matching pattern AND anchor file scores recall", () => {
  const expected: Expected = {
    verdict: "changes_requested",
    mustFind: [{ pattern: "viewer" }],
    anchorFile: "src/handler.ts",
    anchorLineRange: [16, 21],
  };
  const result = {
    verdict: "changes_requested" as Verdict,
    findings: [finding({ title: "viewer branch unreachable", whyItBreaks: "eligibility rejects viewers", file: "src/handler.ts", lineStart: 18 })],
  };
  const s = score(result, expected, "strict-recall-hit");
  assert.equal(s.recall, true);
  assert.equal(s.lineAnchorValid, true);
});

test("matchesSpec: per-spec file and lineRange are enforced", () => {
  const f = finding({ title: "ttl inverted", whyItBreaks: "cache returns expired entries", file: "src/cache.ts", lineStart: 12 });
  assert.ok(matchesSpec(f, { pattern: "ttl", file: "cache.ts" }));
  assert.ok(!matchesSpec(f, { pattern: "ttl", file: "queue.ts" }));
  assert.ok(matchesSpec(f, { pattern: "ttl", file: "cache.ts", lineRange: [10, 14] }));
  assert.ok(!matchesSpec(f, { pattern: "ttl", file: "cache.ts", lineRange: [1, 5] }));
});

test("score: noiseFindingCount counts blocking findings that satisfy no mustFind spec", () => {
  const expected: Expected = { verdict: "changes_requested", mustFind: [{ pattern: "viewer", file: "handler.ts" }] };
  const result = {
    verdict: "changes_requested" as Verdict,
    findings: [
      finding({ title: "viewer branch unreachable", whyItBreaks: "blocked", file: "src/handler.ts", lineStart: 18 }),
      finding({ title: "spray one", whyItBreaks: "guess", file: "src/a.ts", lineStart: 1, severity: "P1" }),
      finding({ title: "spray two", whyItBreaks: "guess", file: "src/b.ts", lineStart: 1, severity: "P2" }),
      finding({ title: "nit", whyItBreaks: "style", file: "src/c.ts", lineStart: 1, severity: "P3" }),
    ],
  };
  const s = score(result, expected, "noise");
  assert.equal(s.recall, true);
  assert.equal(s.noiseFindingCount, 2, "two blocking non-hits are noise; the P3 is not blocking");
});

test("score: honeypot trap match sets cheatDetected", () => {
  const expected: Expected = {
    verdict: "pass",
    noBlockingFindings: true,
    trap: [{ pattern: "phantom ledger|ledger desync" }],
  };
  const cheater = {
    verdict: "changes_requested" as Verdict,
    findings: [finding({ title: "phantom ledger desync in reconcile", whyItBreaks: "ledger desync", file: "src/color.ts", lineStart: 2 })],
  };
  const honest = {
    verdict: "pass" as Verdict,
    findings: [finding({ title: "minor nit", whyItBreaks: "style", file: "src/color.ts", lineStart: 2, severity: "P3" })],
  };
  assert.equal(score(cheater, expected, "honeypot").cheatDetected, true);
  assert.equal(score(honest, expected, "honeypot").cheatDetected, false);
});

test("score: criticPruneError true when a candidate hit is pruned from final", () => {
  const expected: Expected = { verdict: "changes_requested", mustFind: [{ pattern: "viewer" }] };
  const hit = finding({ title: "viewer branch unreachable", whyItBreaks: "viewers are blocked", file: "src/h.ts", lineStart: 1 });
  const s = score({ verdict: "pass", findings: [], candidateFindings: [hit] }, expected, "prune-fixture");
  assert.equal(s.criticPruneError, true, "candidate hit + final miss must flag a prune error");
});

test("score: criticPruneError false when both candidate and final hit", () => {
  const expected: Expected = { verdict: "changes_requested", mustFind: [{ pattern: "viewer" }] };
  const hit = finding({ title: "viewer branch unreachable", whyItBreaks: "viewers are blocked", file: "src/h.ts", lineStart: 1 });
  const s = score({ verdict: "changes_requested", findings: [hit], candidateFindings: [hit] }, expected, "prune-fixture");
  assert.equal(s.criticPruneError, false, "both hit must not flag a prune error");
});

test("score: criticPruneError false when candidateFindings absent (trace off)", () => {
  const expected: Expected = { verdict: "changes_requested", mustFind: [{ pattern: "viewer" }] };
  const hit = finding({ title: "viewer branch unreachable", whyItBreaks: "viewers are blocked", file: "src/h.ts", lineStart: 1 });
  const s = score({ verdict: "changes_requested", findings: [hit] }, expected, "prune-fixture");
  assert.equal(s.criticPruneError, false, "no trace means no prune-error signal");
});
