import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Finding, Verdict } from "../src/shared/schema";
import { aggregateMustFindHitRates, cheatAlert, compare, fixtureSetHash, loadFixtures, mapLimit, parseArgs, filterByHoldout, resumeSlots, writeReport } from "./run";
import { renderResults } from "./gen-results";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { matchesSpec, score } from "./shared/score";
import type { Expected, FixtureSpec, Report } from "./shared/types";
import posOverBlock from "./fixtures/pos-over-block/spec";
import negStyleOnly from "./fixtures/neg-style-only/spec";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

test("aggregateMustFindHitRates averages partial hits by fixture and excludes zero totals", () => {
  const score = (mustFindHits: number, mustFindTotal: number) => ({ mustFindHits, mustFindTotal });
  const result = aggregateMustFindHitRates([
    { fixtureId: "multi", score: score(1, 3) },
    { fixtureId: "multi", score: score(2, 3) },
    { fixtureId: "multi", score: score(3, 3) },
    { fixtureId: "varying", score: score(1, 2) },
    { fixtureId: "varying", score: score(1, 4) },
    { fixtureId: "excluded", score: score(0, 0) },
  ]);

  assert.deepEqual(result.mustFindHitRateByFixture, { multi: 2 / 3, varying: (1 / 2 + 1 / 4) / 2 });
  assert.equal(result.mustFindHitRate, ((2 / 3) + ((1 / 2 + 1 / 4) / 2)) / 2);
});

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

test("loadFixture forces deterministic rename detection when git config disables it", () => {
  const previousCount = process.env.GIT_CONFIG_COUNT;
  const previousKey = process.env.GIT_CONFIG_KEY_0;
  const previousValue = process.env.GIT_CONFIG_VALUE_0;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "diff.renames";
  process.env.GIT_CONFIG_VALUE_0 = "false";

  let loaded: ReturnType<typeof loadFixture> | undefined;
  try {
    loaded = loadFixture({
      ...posOverBlock,
      id: "rename-materialization",
      baseFiles: { "src/old.ts": "export const one = 1;\nexport const two = 2;\nexport const changed = 3;\nexport const four = 4;\n" },
      deletedFiles: ["src/old.ts"],
      renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }],
      headFiles: { "src/new.ts": "export const one = 1;\nexport const two = 2;\nexport const changed = 30;\nexport const four = 4;\n" },
    });
    assert.equal(existsSync(path.join(loaded.bundle.repoPath, "src/old.ts")), false);
    assert.equal(existsSync(path.join(loaded.bundle.repoPath, "src/new.ts")), true);
    assert.match(loaded.bundle.patch, /rename from src\/old\.ts/);
    assert.match(loaded.bundle.patch, /rename to src\/new\.ts/);
    assert.match(loaded.bundle.patchStat, /src\/\{old\.ts => new\.ts\}/);
    assert.deepEqual(loaded.bundle.changedFiles.map((file) => file.path), ["src/new.ts"]);
  } finally {
    loaded?.cleanup();
    if (previousCount === undefined) delete process.env.GIT_CONFIG_COUNT;
    else process.env.GIT_CONFIG_COUNT = previousCount;
    if (previousKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
    else process.env.GIT_CONFIG_KEY_0 = previousKey;
    if (previousValue === undefined) delete process.env.GIT_CONFIG_VALUE_0;
    else process.env.GIT_CONFIG_VALUE_0 = previousValue;
  }
});

test("loadFixture rejects an explicit rename with zero content similarity", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "zero-similarity-rename",
      baseFiles: { "src/old.ts": "export const oldOnly = true;\n" },
      deletedFiles: ["src/old.ts"],
      renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }],
      headFiles: { "src/new.ts": "completely unrelated prose\n" },
    }),
    /explicit rename did not render as a rename: src\/old\.ts -> src\/new\.ts/
  );
});

test("loadFixture rejects a rename destination that already exists in the base tree", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "preexisting-rename-destination",
      baseFiles: { "src/old.ts": "old\n", "src/new.ts": "preexisting\n" },
      deletedFiles: ["src/old.ts"],
      renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }],
      headFiles: { "src/new.ts": "old\n" },
    }),
    /renamedFiles to path already exists in baseFiles: src\/new\.ts/
  );
});

test("loadFixture does not synthesize an independent delete and add into a rename", () => {
  const loaded = loadFixture({
    ...posOverBlock,
    id: "independent-delete-add",
    baseFiles: { "src/old.ts": "export const value = 1;\n" },
    deletedFiles: ["src/old.ts"],
    headFiles: { "src/new.ts": "export const value = 1;\n" },
  });
  try {
    assert.match(loaded.bundle.patch, /deleted file mode/);
    assert.match(loaded.bundle.patch, /new file mode/);
    assert.doesNotMatch(loaded.bundle.patch, /rename from|rename to/);
    assert.deepEqual(loaded.bundle.changedFiles.map((file) => file.path), ["src/new.ts", "src/old.ts"]);
  } finally {
    loaded.cleanup();
  }
});

test("loadFixture materializes a deleted file", () => {
  const loaded = loadFixture({
    ...posOverBlock,
    id: "deletion-materialization",
    baseFiles: { "src/deleted.ts": "export const deleted = true;\n" },
    deletedFiles: ["src/deleted.ts"],
    headFiles: {},
  });
  try {
    assert.equal(existsSync(path.join(loaded.bundle.repoPath, "src/deleted.ts")), false);
    assert.match(loaded.bundle.patch, /deleted file mode/);
    assert.match(loaded.bundle.patch, /-export const deleted = true;/);
  } finally {
    loaded.cleanup();
  }
});

test("loadFixture materializes a pure-add fixture from an empty base commit", () => {
  const loaded = loadFixture({
    ...posOverBlock,
    id: "pure-add-materialization",
    baseFiles: {},
    headFiles: { "src/added.ts": "export const added = true;\n" },
  });
  try {
    assert.match(loaded.bundle.patch, /new file mode/);
    assert.match(loaded.bundle.patch, /\+export const added = true;/);
  } finally {
    loaded.cleanup();
  }
});

test("loadFixture rejects duplicate deletedFiles before materialization", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "duplicate-deletion",
      baseFiles: { "src/deleted.ts": "export const deleted = true;\n" },
      deletedFiles: ["src/deleted.ts", "src/deleted.ts"],
      headFiles: {},
    }),
    /duplicate deletedFiles path: src\/deleted\.ts/
  );
});

test("loadFixture rejects a deleted path that still exists in the head tree", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "deleted-path-retained",
      baseFiles: { "src/deleted.ts": "old\n" },
      deletedFiles: ["src/deleted.ts"],
      headFiles: { "src/deleted.ts": "new\n" },
    }),
    /deletedFiles path still exists in headFiles: src\/deleted\.ts/
  );
});

test("loadFixture rejects a deletedFiles path that is absent from the base tree", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "missing-deletion",
      baseFiles: { "src/present.ts": "export const present = true;\n" },
      deletedFiles: ["src/missing.ts"],
      headFiles: {},
    }),
    /ENOENT|no such file or directory/
  );
});

test("loadFixture validates explicit rename metadata", () => {
  const fixture: FixtureSpec = {
    ...posOverBlock,
    id: "invalid-rename",
    baseFiles: { "src/old.ts": "old\n" },
    deletedFiles: ["src/old.ts"],
    headFiles: { "src/new.ts": "new\n" },
  };
  assert.throws(
    () => loadFixture({ ...fixture, renamedFiles: [{ from: "src/missing.ts", to: "src/new.ts" }] }),
    /renamedFiles from path is not deleted: src\/missing\.ts/
  );
  assert.throws(
    () => loadFixture({ ...fixture, renamedFiles: [{ from: "src/old.ts", to: "src/missing.ts" }] }),
    /renamedFiles to path is absent from headFiles: src\/missing\.ts/
  );
  assert.throws(
    () => loadFixture({ ...fixture, renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }, { from: "src/old.ts", to: "src/other.ts" }] }),
    /duplicate renamedFiles from path: src\/old\.ts/
  );
});

test("loadFixture rejects overlapping explicit rename endpoints", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "overlapping-renames",
      baseFiles: { "src/a.ts": "a\n", "src/b.ts": "b\n" },
      deletedFiles: ["src/a.ts", "src/b.ts"],
      renamedFiles: [{ from: "src/a.ts", to: "src/b.ts" }, { from: "src/b.ts", to: "src/c.ts" }],
      headFiles: { "src/b.ts": "a\n", "src/c.ts": "b\n" },
    }),
    /duplicate renamedFiles endpoint path: src\/b\.ts/
  );
});

test("loadFixture rejects a rename source that remains in the head tree as a deletion overlap", () => {
  assert.throws(
    () => loadFixture({
      ...posOverBlock,
      id: "rename-source-retained",
      baseFiles: { "src/old.ts": "old\n" },
      deletedFiles: ["src/old.ts"],
      renamedFiles: [{ from: "src/old.ts", to: "src/new.ts" }],
      headFiles: { "src/old.ts": "old\n", "src/new.ts": "old\n" },
    }),
    /deletedFiles path still exists in headFiles: src\/old\.ts/
  );
});

test("loadFixture canonicalizes disjoint explicit rename order without mutating the spec", () => {
  const first = { from: "src/a.ts", to: "src/x.ts" };
  const second = { from: "src/b.ts", to: "src/y.ts" };
  const base: FixtureSpec = {
    ...posOverBlock,
    id: "canonical-renames",
    baseFiles: { "src/a.ts": "alpha\n", "src/b.ts": "bravo\n" },
    deletedFiles: ["src/a.ts", "src/b.ts"],
    headFiles: { "src/x.ts": "alpha\n", "src/y.ts": "bravo\n" },
  };
  const forward: FixtureSpec = { ...base, renamedFiles: [first, second] };
  const reversedRenames = [second, first];
  const reversed: FixtureSpec = { ...base, renamedFiles: reversedRenames };
  const forwardLoaded = loadFixture(forward);
  const reversedLoaded = loadFixture(reversed);
  try {
    assert.equal(forwardLoaded.bundle.patch, reversedLoaded.bundle.patch);
    assert.equal(forwardLoaded.bundle.patchStat, reversedLoaded.bundle.patchStat);
    assert.deepEqual(forwardLoaded.bundle.changedFiles, reversedLoaded.bundle.changedFiles);
    assert.equal(fixtureSetHash([forward]), fixtureSetHash([reversed]));
    assert.deepEqual(reversedRenames, [second, first]);
  } finally {
    forwardLoaded.cleanup();
    reversedLoaded.cleanup();
  }
});

test("loadFixture treats a leading-colon rename path as a literal Git pathspec", () => {
  const loaded = loadFixture({
    ...posOverBlock,
    id: "literal-colon-rename",
    baseFiles: { ":weird.ts": "same\n", "src/ordinary.ts": "old\n" },
    deletedFiles: [":weird.ts"],
    renamedFiles: [{ from: ":weird.ts", to: "weird.ts" }],
    headFiles: { "weird.ts": "same\n", "src/ordinary.ts": "new\n" },
  });
  try {
    assert.match(loaded.bundle.patch, /^rename from :weird\.ts$/m);
    assert.match(loaded.bundle.patch, /^rename to weird\.ts$/m);
    assert.match(loaded.bundle.patch, /^diff --git a\/src\/ordinary\.ts b\/src\/ordinary\.ts$/m);
  } finally {
    loaded.cleanup();
  }
});

test("loadFixture isolates character-class rename paths from ordinary changes", () => {
  const loaded = loadFixture({
    ...posOverBlock,
    id: "literal-character-class-rename",
    baseFiles: { "lib[util].ts": "same\n", "libu.ts": "old\n" },
    deletedFiles: ["lib[util].ts"],
    renamedFiles: [{ from: "lib[util].ts", to: "lib_util.ts" }],
    headFiles: { "lib_util.ts": "same\n", "libu.ts": "new\n" },
  });
  try {
    assert.match(loaded.bundle.patch, /^rename from lib\[util\]\.ts$/m);
    assert.match(loaded.bundle.patch, /^rename to lib_util\.ts$/m);
    assert.match(loaded.bundle.patch, /^diff --git a\/libu\.ts b\/libu\.ts$/m);
  } finally {
    loaded.cleanup();
  }
});

test("loadFixture preserves unchanged base-only files when deletedFiles is omitted", () => {
  const loaded = loadFixture({
    ...posOverBlock,
    id: "overlay-materialization",
    baseFiles: {
      "src/context.ts": "export const context = true;\n",
      "src/changed.ts": "export const value = 1;\n",
    },
    headFiles: { "src/changed.ts": "export const value = 2;\n" },
  });
  try {
    assert.equal(existsSync(path.join(loaded.bundle.repoPath, "src/context.ts")), true);
    assert.doesNotMatch(loaded.bundle.patch, /src\/context\.ts/);
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

test("score: mayFind exempts sibling-defect findings from noise but never grants recall", () => {
  const expected: Expected = {
    verdict: "changes_requested",
    mustFind: [{ pattern: "viewer", file: "handler.ts" }],
    mayFind: [{ pattern: "buffer", file: "handler.ts" }],
  };
  const sibling = finding({ title: "buffer cap removed", whyItBreaks: "large diff aborts", file: "src/handler.ts", lineStart: 3, severity: "P1" });
  const noise = finding({ title: "spray", whyItBreaks: "guess", file: "src/a.ts", lineStart: 1, severity: "P1" });

  // Sibling alone: no noise charged, but the mustFind is still unmet.
  const miss = score({ verdict: "changes_requested" as Verdict, findings: [sibling, noise] }, expected, "mayfind-miss");
  assert.equal(miss.recall, false, "mayFind hit must not satisfy recall");
  assert.equal(miss.noiseFindingCount, 1, "sibling is exempt; unrelated spray still counts");

  // Sibling + real hit: recall true, zero noise.
  const hit = score(
    { verdict: "changes_requested" as Verdict, findings: [sibling, finding({ title: "viewer branch unreachable", whyItBreaks: "blocked", file: "src/handler.ts", lineStart: 18 })] },
    expected,
    "mayfind-hit"
  );
  assert.equal(hit.recall, true);
  assert.equal(hit.noiseFindingCount, 0);
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

// --- provenance (real-PR fixture mining, eval/tools/pr2fixture.ts) ---

test("fixtureSetHash: changes when provenance changes, same otherwise", () => {
  const withoutProvenance = holdoutSpec("prov-a", false);
  const withProvenanceA: FixtureSpec = {
    ...withoutProvenance,
    provenance: { repo: "owner/name", pr: 1, kind: "review-finding" },
  };
  const withProvenanceB: FixtureSpec = {
    ...withoutProvenance,
    provenance: { repo: "owner/name", pr: 2, kind: "review-finding" },
  };
  assert.notEqual(fixtureSetHash([withoutProvenance]), fixtureSetHash([withProvenanceA]));
  assert.notEqual(fixtureSetHash([withProvenanceA]), fixtureSetHash([withProvenanceB]));
});

test("fixtureSetHash: unset provenance hashes identically whether the key is omitted or explicitly undefined", () => {
  const implicit = holdoutSpec("prov-b", false);
  const explicit: FixtureSpec = { ...implicit, provenance: undefined };
  assert.equal(fixtureSetHash([implicit]), fixtureSetHash([explicit]));
});

test("fixtureSetHash: changes when deletion metadata changes", () => {
  const withoutDeletion = holdoutSpec("deletion-hash", false);
  const withEmptyDeletion: FixtureSpec = { ...withoutDeletion, deletedFiles: [] };
  const withDeletion: FixtureSpec = { ...withoutDeletion, deletedFiles: ["src/old.ts"] };
  assert.equal(fixtureSetHash([withoutDeletion]), fixtureSetHash([withEmptyDeletion]));
  assert.notEqual(fixtureSetHash([withoutDeletion]), fixtureSetHash([withDeletion]));
});

test("fixtureSetHash: deletion order is canonical but deletion content remains significant", () => {
  const spec = holdoutSpec("deletion-order-hash", false);
  const forward: FixtureSpec = { ...spec, deletedFiles: ["src/a.ts", "src/b.ts"] };
  const reversed: FixtureSpec = { ...spec, deletedFiles: ["src/b.ts", "src/a.ts"] };
  const different: FixtureSpec = { ...spec, deletedFiles: ["src/a.ts", "src/c.ts"] };
  assert.equal(fixtureSetHash([forward]), fixtureSetHash([reversed]));
  assert.notEqual(fixtureSetHash([forward]), fixtureSetHash([different]));
});

test("fixtureSetHash: rename metadata matters, while omission, emptiness, and order are canonical", () => {
  const spec = holdoutSpec("rename-hash", false);
  const first = { from: "src/a.ts", to: "src/b.ts" };
  const second = { from: "src/c.ts", to: "src/d.ts" };
  assert.equal(fixtureSetHash([spec]), fixtureSetHash([{ ...spec, renamedFiles: [] }]));
  assert.notEqual(fixtureSetHash([spec]), fixtureSetHash([{ ...spec, renamedFiles: [first] }]));
  assert.equal(
    fixtureSetHash([{ ...spec, renamedFiles: [first, second] }]),
    fixtureSetHash([{ ...spec, renamedFiles: [second, first] }])
  );
});

test("resumeSlots: a legacy report without fixtureSetHash reuses zero draws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-resume-"));
  const resumePath = path.join(dir, "legacy.json");
  const spec = holdoutSpec("legacy-resume", false);
  const existing: Report = {
    promptHash: promptHash(),
    runner: "codex",
    model: null,
    effort: null,
    draws: 1,
    createdAt: "2026-07-10T00:00:00.000Z",
    baseline: false,
    holdout: "include",
    results: [{
      fixtureId: spec.id,
      draw: 0,
      score: score({ verdict: "pass", findings: [] }, spec.expected, spec.id),
      durationMs: 1,
      calls: 1,
      retries: 0,
    }],
    aggregates: {
      recall: 1,
      falsePositiveRate: 0,
      invalidJsonRate: 0,
      verdictMatchRate: 1,
      lineAnchorValidRate: 1,
      meanDurationMs: 1,
      recallByFixture: { [spec.id]: 1 },
      criticPruneErrorRate: 0,
      recallByTier: { t2: 1 },
      meanNoisePerPositive: 0,
      cheatDetectedCount: 0,
    },
  };
  writeFileSync(resumePath, JSON.stringify(existing));
  try {
    const args = parseArgs(["--draws", "1", "--resume", resumePath]);
    const resumed = resumeSlots(args, [spec], [{ spec, draw: 0 }]);
    assert.equal(resumed.skipped, 0);
    assert.deepEqual(resumed.slots, [null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function resumeReport(spec: FixtureSpec, overrides: Partial<Report>): Report {
  return {
    promptHash: promptHash(),
    runner: "codex",
    model: null,
    effort: null,
    draws: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    baseline: false,
    holdout: "include",
    fixtureSetHash: fixtureSetHash([spec]),
    fixtures: [spec.id],
    results: [{
      fixtureId: spec.id,
      draw: 0,
      score: score({ verdict: "pass", findings: [] }, spec.expected, spec.id),
      durationMs: 1,
      calls: 1,
      retries: 0,
    }],
    aggregates: {
      recall: 1,
      falsePositiveRate: 0,
      invalidJsonRate: 0,
      verdictMatchRate: 1,
      lineAnchorValidRate: 1,
      meanDurationMs: 1,
      recallByFixture: { [spec.id]: 1 },
      criticPruneErrorRate: 0,
      recallByTier: { t2: 1 },
      meanNoisePerPositive: 0,
      cheatDetectedCount: 0,
    },
    ...overrides,
  };
}

test("resumeSlots: a report from before the anti-cheat guards reuses zero draws", () => {
  // Draws that never faced canary detection must not populate a new report.
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-resume-"));
  const resumePath = path.join(dir, "pre-anticheat.json");
  const spec = holdoutSpec("pre-anticheat-resume", false);
  writeFileSync(resumePath, JSON.stringify(resumeReport(spec, {})));
  try {
    const args = parseArgs(["--draws", "1", "--resume", resumePath]);
    const resumed = resumeSlots(args, [spec], [{ spec, draw: 0 }]);
    assert.equal(resumed.skipped, 0);
    assert.deepEqual(resumed.slots, [null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeSlots and compare fail closed on a missing cheatDetectedCount", () => {
  // Unvalidated JSON: a current-version report omitting the count cannot be
  // established clean — resume reuses nothing, compare throws.
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-countless-"));
  const spec = holdoutSpec("countless-gate", false);
  const base = resumeReport(spec, { anticheatVersion: 1 });
  const strippedAggregates = { ...base.aggregates } as Record<string, unknown>;
  delete strippedAggregates.cheatDetectedCount;
  const countless = { ...base, aggregates: strippedAggregates };
  try {
    const resumePath = path.join(dir, "countless.json");
    writeFileSync(resumePath, JSON.stringify(countless));
    const args = parseArgs(["--draws", "1", "--resume", resumePath]);
    const resumed = resumeSlots(args, [spec], [{ spec, draw: 0 }]);
    assert.equal(resumed.skipped, 0, "count-less draws must not be reused");
    assert.deepEqual(resumed.slots, [null]);

    const cleanPath = path.join(dir, "clean.json");
    writeFileSync(cleanPath, JSON.stringify(base));
    assert.throws(
      () => compare(resumePath, base),
      /compromised or unverifiable/,
      "a count-less baseline must not anchor a comparison",
    );
    assert.throws(
      () => compare(cleanPath, countless as unknown as Report),
      /compromised or unverifiable/,
      "a count-less candidate must not pass a comparison",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderResults: legacy and compromised reports are excluded from baseline and deltas", () => {
  // The published results table honors the same comparability contract as
  // resume/compare/weekly: pre-guard or canary-positive reports are listed
  // but never selected as baseline nor given a delta.
  const spec = holdoutSpec("gen-results-gate", false);
  const clean = resumeReport(spec, { anticheatVersion: 1, effort: "xhigh" });
  const grokClean = resumeReport(spec, {
    anticheatVersion: 1,
    runner: "grok",
    effort: "low",
  });
  const legacy = resumeReport(spec, { effort: "xhigh" });
  const compromisedBase = resumeReport(spec, { anticheatVersion: 1 });
  const compromised = {
    ...compromisedBase,
    aggregates: { ...compromisedBase.aggregates, cheatDetectedCount: 1 },
  };
  const md = renderResults(
    [spec],
    [
      { stem: "legacy-run", report: legacy },
      { stem: "clean-codex-xhigh", report: clean },
      { stem: "clean-grok-low", report: grokClean },
      { stem: "cheat-run", report: compromised },
    ],
  );
  const row = (stem: string): string =>
    md.split("\n").find((l) => l.includes(`| ${stem} |`) || l.includes(`${stem} |`)) ?? "";
  assert.match(row("clean-codex-xhigh"), /\(baseline\)/, "guarded codex-xhigh is the baseline");
  assert.ok(!row("clean-codex-xhigh").includes("🚫"));
  assert.match(row("legacy-run"), /🚫/, "pre-guard report is marked");
  assert.match(row("legacy-run"), /n\/a/, "pre-guard report gets no delta");
  assert.match(row("cheat-run"), /🚫/, "compromised report is marked");
  assert.match(row("cheat-run"), /COMPROMISED/, "compromised report is labeled");
  assert.match(row("cheat-run"), /n\/a/, "compromised report gets no delta");
  assert.ok(
    !row("cheat-run").includes("%"),
    "a compromised report publishes no aggregate metric values",
  );
  assert.equal(
    row("cheat-run").split("|").map((c) => c.trim())[3],
    "—",
    "a compromised report withholds its draw count",
  );
  // Fixture-level cells for the compromised column are withheld too: the
  // 4th cell (cheat-run's) is "—" while the others carry hit counts.
  const fixtureRow = md.split("\n").find((l) => l.startsWith(`| ${spec.id} |`)) ?? "";
  assert.equal(
    fixtureRow.split("|").map((c) => c.trim())[5],
    "—",
    "compromised report's fixture-level recall is withheld",
  );
  assert.ok(!row("clean-grok-low").includes("🚫"), "guarded report is not marked");
  assert.ok(!row("clean-grok-low").includes("n/a"), "guarded report stays comparable");
});

test("renderResults: report manifests determine completeness and baseline eligibility", () => {
  const spec = holdoutSpec("gen-results-partial-baseline", false);
  const extraSpec = holdoutSpec("gen-results-manifest-extra", false);
  const fixtures = [spec.id, extraSpec.id];
  const setHash = fixtureSetHash([spec, extraSpec]);
  const partialBase = resumeReport(spec, {
    anticheatVersion: 1,
    effort: "xhigh",
    draws: 2,
    fixtures,
    fixtureSetHash: setHash,
  });
  const completeBase = resumeReport(spec, {
    anticheatVersion: 1,
    runner: "grok",
    effort: "medium",
    draws: 2,
    fixtures,
    fixtureSetHash: setHash,
  });
  const missingManifestBase = resumeReport(spec, {
    anticheatVersion: 1,
    effort: "xhigh",
    draws: 2,
    fixtureSetHash: setHash,
  });
  const { fixtures: removedFixtures, ...missingManifest } = missingManifestBase;
  assert.deepEqual(removedFixtures, [spec.id]);

  const template = completeBase.results[0];
  assert.ok(template);
  const fullResults = [
    { ...template, fixtureId: spec.id, draw: 0 },
    { ...template, fixtureId: spec.id, draw: 1 },
    { ...template, fixtureId: extraSpec.id, draw: 0 },
    { ...template, fixtureId: extraSpec.id, draw: 1 },
  ];
  const partial: Report = { ...partialBase, results: fullResults.slice(0, 3) };
  const duplicatePair: Report = {
    ...partialBase,
    results: [fullResults[0]!, fullResults[1]!, fullResults[2]!, fullResults[2]!],
  };
  const outsideFixture: Report = {
    ...partialBase,
    results: [
      fullResults[0]!,
      fullResults[1]!,
      fullResults[2]!,
      { ...fullResults[3]!, fixtureId: "outside-manifest" },
    ],
  };
  const duplicateManifest: Report = {
    ...partialBase,
    fixtures: [spec.id, spec.id],
    results: fullResults,
  };
  const outOfRangeDraw: Report = {
    ...partialBase,
    results: [
      fullResults[0]!,
      fullResults[1]!,
      fullResults[2]!,
      { ...fullResults[3]!, draw: 2 },
    ],
  };
  const complete: Report = { ...completeBase, results: fullResults };

  // The renderer sees one display spec, while both current reports declare two
  // fixtures. Completeness must come from each report's own manifest.
  const md = renderResults(
    [spec],
    [
      { stem: "missing-manifest-codex", report: missingManifest },
      { stem: "partial-codex-xhigh", report: partial },
      { stem: "duplicate-pair-codex", report: duplicatePair },
      { stem: "outside-fixture-codex", report: outsideFixture },
      { stem: "duplicate-manifest-codex", report: duplicateManifest },
      { stem: "out-of-range-draw-codex", report: outOfRangeDraw },
      { stem: "complete-grok-medium", report: complete },
    ],
  );
  const row = (stem: string): string =>
    md.split("\n").find((line) => line.includes(`${stem} |`)) ?? "";
  const cells = (stem: string): string[] =>
    row(stem).split("|").map((cell) => cell.trim());

  assert.doesNotMatch(row("missing-manifest-codex"), /\(baseline\)/);
  assert.equal(cells("missing-manifest-codex")[3], "1/?");
  assert.doesNotMatch(row("partial-codex-xhigh"), /\(baseline\)/);
  assert.equal(cells("partial-codex-xhigh")[3], "3/4");
  assert.equal(cells("partial-codex-xhigh")[5], "—");
  for (const stem of [
    "duplicate-pair-codex",
    "outside-fixture-codex",
    "out-of-range-draw-codex",
  ]) {
    assert.doesNotMatch(row(stem), /\(baseline\)/, `${stem} must not anchor`);
    assert.match(row(stem), /⚠️/, `${stem} must be marked incomplete`);
    assert.equal(cells(stem)[3], "4/4", `${stem} keeps its valid denominator`);
    assert.equal(cells(stem)[5], "—", `${stem} gets no delta`);
  }
  assert.doesNotMatch(row("duplicate-manifest-codex"), /\(baseline\)/);
  assert.match(row("duplicate-manifest-codex"), /⚠️/);
  assert.equal(cells("duplicate-manifest-codex")[3], "4/?");
  assert.equal(cells("duplicate-manifest-codex")[5], "—");
  assert.match(row("complete-grok-medium"), /\(baseline\)/);
  assert.equal(cells("complete-grok-medium")[3], "4/4");
});

test("gen-baseline-doc refuses unsafe or incomplete reports", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-baseline-doc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const specs = await loadFixtures(null);
  const fixtureIds = specs.map((spec) => spec.id);
  const seed = resumeReport(specs[0]!, { anticheatVersion: 1 });
  const template = seed.results[0]!;
  const complete: Report = {
    ...seed,
    fixtures: fixtureIds,
    fixtureSetHash: fixtureSetHash(specs),
    results: fixtureIds.map((fixtureId) => ({ ...template, fixtureId })),
  };
  const missingManifest = { ...complete };
  Reflect.deleteProperty(missingManifest, "fixtures");
  assert.equal("fixtures" in missingManifest, false);
  const duplicatePair: Report = {
    ...complete,
    results: [complete.results[0]!, ...complete.results.slice(0, -1)],
  };
  const foreignFixture: Report = {
    ...complete,
    results: [
      { ...complete.results[0]!, fixtureId: "outside-manifest" },
      ...complete.results.slice(1),
    ],
  };
  const outOfRangeDraw: Report = {
    ...complete,
    results: [
      { ...complete.results[0]!, draw: 1 },
      ...complete.results.slice(1),
    ],
  };
  const compromised: Report = {
    ...complete,
    aggregates: { ...complete.aggregates, cheatDetectedCount: 1 },
  };
  const missingCheatCount = { ...complete.aggregates };
  Reflect.deleteProperty(missingCheatCount, "cheatDetectedCount");
  assert.equal("cheatDetectedCount" in missingCheatCount, false);
  const hostileReports: readonly (readonly [string, Report])[] = [
    ["legacy", { ...complete, anticheatVersion: undefined }],
    ["compromised", compromised],
    [
      "missing-cheat-count",
      { ...complete, aggregates: missingCheatCount as Report["aggregates"] },
    ],
    [
      "non-numeric-cheat-count",
      {
        ...complete,
        aggregates: {
          ...complete.aggregates,
          cheatDetectedCount: "0" as unknown as number,
        },
      },
    ],
    ["missing-manifest", missingManifest],
    ["empty-manifest", { ...complete, fixtures: [] }],
    ["empty-fixture-id", { ...complete, fixtures: [""] }],
    [
      "non-string-fixture-id",
      { ...complete, fixtures: [123 as unknown as string] },
    ],
    [
      "duplicate-manifest",
      { ...complete, fixtures: [fixtureIds[0]!, fixtureIds[0]!] },
    ],
    ["zero-draws", { ...complete, draws: 0 }],
    ["fractional-draws", { ...complete, draws: 1.5 }],
    ["partial-coverage", { ...complete, results: complete.results.slice(0, -1) }],
    ["duplicate-pair", duplicatePair],
    ["foreign-fixture", foreignFixture],
    ["out-of-range-draw", outOfRangeDraw],
    [
      "fractional-result-draw",
      {
        ...complete,
        results: [{ ...complete.results[0]!, draw: 0.5 }, ...complete.results.slice(1)],
      },
    ],
    [
      "filtered-subset",
      { ...complete, fixtures: fixtureIds.slice(0, 1), results: complete.results.slice(0, 1) },
    ],
    ["missing-prompt-hash", { ...complete, promptHash: "" }],
    [
      "absent-prompt-hash",
      (() => {
        const r = { ...complete };
        Reflect.deleteProperty(r, "promptHash");
        return r as Report;
      })(),
    ],
    ["missing-fixture-set-hash", { ...complete, fixtureSetHash: "" }],
    [
      "absent-fixture-set-hash",
      (() => {
        const r = { ...complete };
        Reflect.deleteProperty(r, "fixtureSetHash");
        return r as Report;
      })(),
    ],
    [
      "wrong-fixture-set-hash",
      { ...complete, fixtureSetHash: "deadbeefdeadbeef" },
    ],
  ];
  const repoRoot = path.resolve(__dirname, "..");
  const baselineDocPath = path.join(repoRoot, "eval", "BASELINE.md");
  const baselineBefore = readFileSync(baselineDocPath);
  t.after(() => writeFileSync(baselineDocPath, baselineBefore));

  const multiDrawReport: Report = {
    ...complete,
    draws: 2,
    results: fixtureIds.flatMap((fixtureId) => [0, 1].map((draw) => ({
      ...template,
      fixtureId,
      draw,
    }))),
  };
  const multiDrawPath = path.join(dir, "multi-draw.json");
  writeFileSync(multiDrawPath, JSON.stringify(multiDrawReport));
  const multiDrawResult = spawnSync(
    "npx",
    ["tsx", path.join("eval", "gen-baseline-doc.ts"), multiDrawPath],
    { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
  );
  try {
    assert.equal(
      multiDrawResult.status,
      0,
      `complete multi-draw report must generate, stderr: ${multiDrawResult.stderr}`,
    );
    const generated = readFileSync(baselineDocPath, "utf8");
    assert.match(
      generated,
      new RegExp(`^- \\*\\*fixtures:\\*\\* ${fixtureIds.length} \\(`, "m"),
    );
    assert.doesNotMatch(
      generated,
      new RegExp(`^- \\*\\*fixtures:\\*\\* ${multiDrawReport.results.length} \\(`, "m"),
    );
  } finally {
    writeFileSync(baselineDocPath, baselineBefore);
  }

  for (const [name, report] of hostileReports) {
    const reportPath = path.join(dir, `${name}.json`);
    writeFileSync(reportPath, JSON.stringify(report));
    const res = spawnSync(
      "npx",
      ["tsx", path.join("eval", "gen-baseline-doc.ts"), reportPath],
      { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(res.status, 1, `${name} must exit 1, stderr: ${res.stderr}`);
    assert.match(res.stderr, /refusing to generate baseline doc/);
    assert.doesNotMatch(res.stderr, /wrote eval\/BASELINE\.md/);
    assert.deepEqual(
      readFileSync(baselineDocPath),
      baselineBefore,
      `${name} must not alter BASELINE.md`,
    );
  }

  // No default report: every committed baseline predates the guards and
  // would deterministically fail the gate — the no-arg invocation must print
  // usage before reading anything, not chase a stale hardcoded path.
  const noArg = spawnSync("npx", ["tsx", path.join("eval", "gen-baseline-doc.ts")], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(noArg.status, 1, `no-arg must exit 1, stderr: ${noArg.stderr}`);
  assert.match(noArg.stderr, /usage: /);
  assert.doesNotMatch(noArg.stderr, /refusing to generate baseline doc/);
});

test("renderResults: mixed prompt hashes are reported, not asserted shared", () => {
  const spec = holdoutSpec("gen-results-hashes", false);
  const a = resumeReport(spec, { anticheatVersion: 1, effort: "xhigh" });
  const b = resumeReport(spec, {
    anticheatVersion: 1,
    runner: "grok",
    promptHash: "different-prompt-generation",
  });
  const md = renderResults(
    [],
    [
      { stem: "a-current", report: a },
      { stem: "b-other-prompt", report: b },
    ],
  );
  assert.ok(
    !md.includes("All runs share promptHash"),
    "mixed hashes must not claim a shared hash",
  );
  assert.match(md, /Mixed prompt hashes/);
  const row = md.split("\n").find((l) => l.includes("b-other-prompt")) ?? "";
  assert.match(row, /n\/a/, "a cross-prompt row is not comparable");
});

test("renderResults: hashless reports neither anchor nor join comparisons", () => {
  // Reports come from unvalidated disk JSON: two reports both missing
  // fixtureSetHash would compare `undefined === undefined` and publish
  // deltas across unknown fixture sets. Hash presence is part of the gate.
  const spec = holdoutSpec("gen-results-hashless", false);
  const a = resumeReport(spec, {
    anticheatVersion: 1,
    effort: "xhigh",
  });
  Reflect.deleteProperty(a, "fixtureSetHash");
  assert.equal("fixtureSetHash" in a, false);
  const b = resumeReport(spec, {
    anticheatVersion: 1,
  });
  Reflect.deleteProperty(b, "fixtureSetHash");
  assert.equal("fixtureSetHash" in b, false);
  const md = renderResults(
    [],
    [
      { stem: "a-hashless", report: a },
      { stem: "b-hashless", report: b },
    ],
  );
  assert.match(
    md,
    /No guarded report qualifies as a baseline/,
    "a hashless report must not be selected as baseline",
  );
  for (const stem of ["a-hashless", "b-hashless"]) {
    const row = md.split("\n").find((l) => l.includes(stem)) ?? "";
    assert.match(row, /n\/a/, `${stem} must not publish a delta`);
  }
});

test("writeReport: anticheatVersion is only earned when HOME isolation AND tracing were on", (t) => {
  // The version label is a promise the guards ran. A run whose user --env
  // disabled isolation OR the eval trace (which feeds critic-pruned
  // candidates and failed raws to the canary scan) must produce an honestly
  // unversioned report that resume/compare will refuse.
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-report-"));
  const spec = holdoutSpec("version-label", false);
  const previous = {
    home: process.env.NEEDLEFISH_EPHEMERAL_HOME,
    trace: process.env.NEEDLEFISH_EVAL_TRACE,
  };
  t.after(() => {
    if (previous.home === undefined) delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
    else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.home;
    if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
    else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
    rmSync(dir, { recursive: true, force: true });
  });

  const reportPath = path.join(dir, "report.json");
  const args = parseArgs(["--draws", "1", "--report", reportPath]);

  process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
  process.env.NEEDLEFISH_EVAL_TRACE = "1";
  const guarded = writeReport(args, [], [spec]);
  assert.equal(guarded.anticheatVersion, 1);

  const dryRunArgs = parseArgs([
    "--dry-run",
    "--draws",
    "1",
    "--report",
    reportPath,
  ]);
  const dryRun = writeReport(dryRunArgs, [], [spec]);
  assert.equal(
    dryRun.anticheatVersion,
    undefined,
    "a dry run must not claim guards protected model draws that never ran",
  );

  process.env.NEEDLEFISH_EPHEMERAL_HOME = "0";
  const unguarded = writeReport(args, [], [spec]);
  assert.equal(
    unguarded.anticheatVersion,
    undefined,
    "a run without HOME isolation must not claim the guard generation",
  );

  process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
  process.env.NEEDLEFISH_EVAL_TRACE = "0";
  const untraced = writeReport(args, [], [spec]);
  assert.equal(
    untraced.anticheatVersion,
    undefined,
    "a run without eval tracing must not claim the guard generation",
  );

  // claude is exempt from HOME isolation by design (Keychain auth): its lanes
  // never earn the label, even with both guard flags on — certifying one
  // would promise a G1 guarantee its draws did not have.
  process.env.NEEDLEFISH_EVAL_TRACE = "1";
  const claudeArgs = parseArgs([
    "--runner",
    "claude",
    "--draws",
    "1",
    "--report",
    reportPath,
  ]);
  const claudeLane = writeReport(claudeArgs, [], [spec]);
  assert.equal(
    claudeLane.anticheatVersion,
    undefined,
    "a claude lane must not be certified as HOME-isolated",
  );
});

test("resumeSlots: a compromised report is not resumed", () => {
  // Current guard generation, but the trap fired: the whole report is void
  // (see cheatAlert) and none of its draws may seed a fresh one.
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-resume-"));
  const resumePath = path.join(dir, "compromised.json");
  const spec = holdoutSpec("compromised-resume", false);
  const base = resumeReport(spec, { anticheatVersion: 1 });
  writeFileSync(
    resumePath,
    JSON.stringify({
      ...base,
      aggregates: { ...base.aggregates, cheatDetectedCount: 1 },
    }),
  );
  try {
    const args = parseArgs(["--draws", "1", "--resume", resumePath]);
    const resumed = resumeSlots(args, [spec], [{ spec, draw: 0 }]);
    assert.equal(resumed.skipped, 0);
    assert.deepEqual(resumed.slots, [null]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resumeSlots: a current-generation anti-cheat report reuses its draws", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-resume-"));
  const resumePath = path.join(dir, "current.json");
  const spec = holdoutSpec("current-anticheat-resume", false);
  writeFileSync(
    resumePath,
    JSON.stringify(resumeReport(spec, { anticheatVersion: 1 })),
  );
  try {
    const args = parseArgs(["--draws", "1", "--resume", resumePath]);
    const resumed = resumeSlots(args, [spec], [{ spec, draw: 0 }]);
    assert.equal(resumed.skipped, 1);
    assert.notEqual(resumed.slots[0], null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cheatAlert: a detected canary fails the command, a clean report does not", () => {
  const spec = holdoutSpec("cheat-alert-exit", false);
  const previousExitCode = process.exitCode;
  const previousWrite = process.stderr.write.bind(process.stderr);
  let alertText = "";
  try {
    process.exitCode = undefined;
    cheatAlert(resumeReport(spec, {}));
    assert.equal(process.exitCode, undefined, "clean report must not set exitCode");
    const compromised = resumeReport(spec, {});
    process.stderr.write = ((chunk: string | Uint8Array) => {
      alertText += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    cheatAlert({
      ...compromised,
      aggregates: { ...compromised.aggregates, cheatDetectedCount: 1 },
    });
    assert.equal(process.exitCode, 1, "compromised report must fail the command");
    assert.match(alertText, /anti-cheat detection fired/);
    assert.match(alertText, /repository answer-key canary and\/or honeypot/);
    assert.doesNotMatch(
      alertText,
      /honeypot trap matched/,
      "canary-only hits must not be diagnosed as honeypot-only",
    );
  } finally {
    process.stderr.write = previousWrite;
    process.exitCode = previousExitCode;
  }
});

test("compare: rejects a legacy baseline without fixtureSetHash", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-compare-"));
  const baselinePath = path.join(dir, "baseline.json");
  const candidate: Report = {
    promptHash: "prompt-hash",
    runner: "codex",
    model: null,
    effort: null,
    draws: 1,
    createdAt: "2026-07-10T00:00:00.000Z",
    baseline: false,
    holdout: "include",
    results: [],
    aggregates: {
      recall: 0,
      falsePositiveRate: 0,
      invalidJsonRate: 0,
      verdictMatchRate: 0,
      lineAnchorValidRate: 0,
      meanDurationMs: 0,
      recallByFixture: {},
      criticPruneErrorRate: 0,
      recallByTier: {},
      meanNoisePerPositive: 0,
      cheatDetectedCount: 0,
    },
    fixtureSetHash: "fixture-hash",
  };
  const legacyBaseline = { ...candidate, baseline: true };
  delete legacyBaseline.fixtureSetHash;
  writeFileSync(baselinePath, JSON.stringify(legacyBaseline));
  try {
    assert.throws(() => compare(baselinePath, candidate), /baseline report is missing fixtureSetHash/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("compare: rejects reports from another anti-cheat generation", () => {
  // An unguarded baseline is not comparable to a guarded candidate — its
  // draws never faced the canary. Same for an unguarded candidate.
  const dir = mkdtempSync(path.join(tmpdir(), "needlefish-compare-"));
  const baselinePath = path.join(dir, "baseline.json");
  const draw = (fixtureId: string, drawIndex: number) => ({
    fixtureId,
    draw: drawIndex,
    score: score({ verdict: "pass", findings: [] }, { verdict: "pass" }, fixtureId),
    durationMs: 1,
    calls: 1,
    retries: 0,
  });
  // Complete fixture × draw coverage so the success path reaches metrics.
  const current: Report = {
    promptHash: "prompt-hash",
    runner: "codex",
    model: null,
    effort: null,
    draws: 1,
    createdAt: "2026-07-13T00:00:00.000Z",
    baseline: false,
    holdout: "include",
    fixtures: ["fx-a", "fx-b"],
    results: [draw("fx-a", 0), draw("fx-b", 0)],
    aggregates: {
      recall: 0,
      falsePositiveRate: 0,
      invalidJsonRate: 0,
      verdictMatchRate: 0,
      lineAnchorValidRate: 0,
      meanDurationMs: 0,
      recallByFixture: {},
      criticPruneErrorRate: 0,
      recallByTier: {},
      meanNoisePerPositive: 0,
      cheatDetectedCount: 0,
    },
    fixtureSetHash: "fixture-hash",
    anticheatVersion: 1,
  };
  try {
    const unguardedBaseline = { ...current, baseline: true };
    delete unguardedBaseline.anticheatVersion;
    writeFileSync(baselinePath, JSON.stringify(unguardedBaseline));
    assert.throws(
      () => compare(baselinePath, current),
      /baseline report anti-cheat version is none/,
    );

    writeFileSync(baselinePath, JSON.stringify({ ...current, baseline: true }));
    const unguardedCandidate = { ...current };
    delete unguardedCandidate.anticheatVersion;
    assert.throws(
      () => compare(baselinePath, unguardedCandidate),
      /candidate report anti-cheat version is none/,
    );

    // Matching current-generation reports still compare cleanly.
    compare(baselinePath, current);

    // A current-generation report whose trap fired is void: it must not
    // anchor (or pass) a comparison even though its version matches.
    const compromisedBaseline = {
      ...current,
      baseline: true,
      aggregates: { ...current.aggregates, cheatDetectedCount: 1 },
    };
    writeFileSync(baselinePath, JSON.stringify(compromisedBaseline));
    assert.throws(
      () => compare(baselinePath, current),
      /baseline report is compromised or unverifiable \(cheatDetectedCount=1\)/,
    );

    // Partial coverage (3/4 draws) must not print comparison metrics.
    const incomplete = {
      ...current,
      draws: 2,
      results: [draw("fx-a", 0), draw("fx-b", 0), draw("fx-a", 1)],
    };
    writeFileSync(baselinePath, JSON.stringify({ ...current, baseline: true }));
    assert.throws(
      () => compare(baselinePath, incomplete),
      /candidate report is incomplete/,
    );
    writeFileSync(baselinePath, JSON.stringify({ ...incomplete, baseline: true }));
    assert.throws(
      () => compare(baselinePath, current),
      /baseline report is incomplete/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadFixtures: discovers a fixture placed in eval/fixtures-real/", async () => {
  const realDir = path.join(__dirname, "fixtures-real");
  const tmpFixtureDir = path.join(realDir, "tmp-discovery-test");
  mkdirSync(tmpFixtureDir, { recursive: true });
  writeFileSync(
    path.join(tmpFixtureDir, "spec.ts"),
    `import type { FixtureSpec } from "../../shared/types";
const spec: FixtureSpec = {
  id: "tmp-discovery-test",
  kind: "negative",
  defectClass: "test",
  description: "test",
  baseFiles: {},
  headFiles: {},
  expected: { verdict: "pass", noBlockingFindings: true },
};
export default spec;
`
  );
  try {
    const specs = await loadFixtures(null);
    assert.ok(specs.some((s) => s.id === "tmp-discovery-test"), "discovered fixture missing from loadFixtures() result");
  } finally {
    rmSync(tmpFixtureDir, { recursive: true, force: true });
  }
});
