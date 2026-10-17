import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function fixture(t: test.TestContext, result: Record<string, unknown> | string): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-cached-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = path.join(tmp, "last-review.json");
  writeFileSync(
    file,
    typeof result === "string" ? result : `${JSON.stringify(result, null, 2)}\n`
  );
  return file;
}

function baseResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    verdict: "pass",
    summary: "Looks fine.",
    findings: [],
    checked: ["checked the diff"],
    residualRisks: [],
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    ...overrides,
  };
}

function runCli(args: readonly string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), ...args],
    { cwd: process.cwd(), encoding: "utf8" }
  );
}

test("render prints the cached result through renderMarkdown", (t) => {
  const file = fixture(
    t,
    baseResult({
      verdict: "changes_requested",
      findings: [
        {
          severity: "P1",
          title: "Drops the sentinel check",
          category: "bug",
          file: "src/app.ts",
          lineStart: 10,
          lineEnd: 12,
          confidence: 0.9,
          whyItBreaks: "the sentinel is removed",
          suggestedFix: "restore it",
          validation: "add a regression test",
        },
      ],
      reviewTarget: "Review target: merge-base..HEAD",
      coverage: "1/1 changed files deep-reviewed",
      stats: [
        { label: "review", runner: "claude", durationMs: 1200, attempts: 1, ok: true },
      ],
      totalDurationMs: 1500,
    })
  );

  const result = runCli(["render", file]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /CHANGES REQUESTED/);
  assert.match(result.stdout, /Drops the sentinel check/);
  assert.match(result.stdout, /src\/app\.ts:10/);
  assert.match(result.stdout, /## Findings/);
  assert.match(result.stdout, /Coverage: 1\/1 changed files deep-reviewed/);
  assert.match(result.stdout, /Review target: merge-base\.\.HEAD/);
  assert.match(result.stdout, /1 call · review 1\.2s|review 0m 1s|review 1s/);
});

test("verdict prints stored and derived verdicts", (t) => {
  const file = fixture(
    t,
    baseResult({
      verdict: "changes_requested",
      findings: [
        {
          severity: "P2",
          title: "breaks",
          category: "bug",
          file: "src/app.ts",
          lineStart: 1,
          lineEnd: 1,
          confidence: 0.9,
          whyItBreaks: "w",
          suggestedFix: "f",
          validation: "",
        },
      ],
    })
  );

  const result = runCli(["verdict", file]);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /stored: {2}changes_requested\n/);
  assert.match(result.stdout, /derived: changes_requested\n/);
  assert.equal(result.stderr, "");
});

test("verdict exits 1 when stored and derived verdicts drift", (t) => {
  const file = fixture(
    t,
    baseResult({
      verdict: "pass",
      residualRisks: [{ text: "auth path not reviewed", blocks: true }],
    })
  );

  const result = runCli(["verdict", file]);

  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stdout, /stored: {2}pass\n/);
  assert.match(result.stdout, /derived: needs_human\n/);
  assert.match(result.stderr, /does not match derived/);
});

test("render rejects a malformed cache file", (t) => {
  const file = fixture(t, "{not json");

  const result = runCli(["render", file]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid cached review/);
});

test("cached commands reject blank legacy content without printing a verdict", (t) => {
  const invalid = [
    { summary: "" },
    { summary: " \t\r\n\u3000" },
    { checked: [] },
    { checked: [""] },
    { checked: [" \t", "\n\u3000"] },
    { checked: ["inspected diff", null] },
    { summary: " ", checked: [""] },
    {
      verdict: "needs_human", checked: [" "],
      residualRisks: [{ text: "not reviewed", blocks: true }],
    },
    {
      verdict: "changes_requested", checked: [" "],
      findings: [{
        severity: "P2", title: "breaks", category: "bug", file: "src/app.ts",
        lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: "w",
        suggestedFix: "f", validation: "",
      }],
    },
  ];
  for (const overrides of invalid) {
    const file = fixture(t, baseResult(overrides));
    for (const command of ["render", "verdict"]) {
      const result = runCli([command, file]);
      assert.equal(result.status, 1, `${command} ${JSON.stringify(overrides)}: ${result.stdout}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /invalid cached review.*malformed review/);
    }
  }
});

test("cached commands preserve a valid legacy pass without rewriting the cache", (t) => {
  const file = fixture(t, baseResult({
    summary: "  Legacy review.  ", checked: ["", "  inspected diff  "],
  }));
  const before = readFileSync(file, "utf8");
  const rendered = runCli(["render", file]);
  assert.equal(rendered.status, 0, rendered.stderr);
  assert.match(rendered.stdout, /LGTM/);
  assert.match(rendered.stdout, /Legacy review\./);
  assert.match(rendered.stdout, / {2}inspected diff {2}/);
  const verdict = runCli(["verdict", file]);
  assert.equal(verdict.status, 0, verdict.stderr);
  assert.equal(verdict.stdout, "stored:  pass\nderived: pass\n");
  assert.equal(readFileSync(file, "utf8"), before);
});

test("render rejects a cache file with a verdict outside the schema", (t) => {
  const file = fixture(t, baseResult({ verdict: "lgtm" }));

  const result = runCli(["render", file]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid verdict/);
});

test("render reports a missing file without a stack trace", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-cached-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));

  const result = runCli(["render", path.join(tmp, "absent.json")]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot read cached review/);
});


test("cached commands reject padded quotes and preserve valid quote and legacy caches", (t) => {
  const finding = {
    severity: "P2", title: "breaks", category: "bug", file: "src/app.ts",
    lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: "w",
    suggestedFix: "f", validation: "",
  };
  for (const quotedFinding of [
    { ...finding, quote: "  source  " },
    { ...finding, quote: "source  inside" },
    finding,
  ]) {
    const file = fixture(t, baseResult({ verdict: "changes_requested", findings: [quotedFinding] }));
    const before = readFileSync(file, "utf8");
    for (const command of ["render", "verdict"]) {
      const result = runCli([command, file]);
      if ("quote" in quotedFinding && quotedFinding.quote === "  source  ") {
        assert.equal(result.status, 1, result.stdout);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /invalid cached review.*quote/);
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stderr, "");
        if (command === "verdict") {
          assert.equal(result.stdout, "stored:  changes_requested\nderived: changes_requested\n");
        } else {
          assert.match(result.stdout, /CHANGES REQUESTED/);
          assert.match(result.stdout, /breaks/);
          assert.match(result.stdout, /src\/app\.ts:1/);
        }
      }
    }
    assert.equal(readFileSync(file, "utf8"), before);
  }
});
for (const command of ["render", "verdict"]) {
  for (const verdict of ["pass", "needs_human"]) {
    test(`${command} exits ${verdict === "pass" ? 0 : 1} for ${verdict}`, (t) => {
      const file = fixture(t, baseResult({
        verdict,
        residualRisks: verdict === "needs_human"
          ? [{ text: "auth.ts not reviewed", blocks: true }]
          : [],
      }));
      const result = runCli([command, file]);
      assert.equal(result.status, verdict === "pass" ? 0 : 1, result.stderr);
      if (command === "render" && verdict === "needs_human") {
        assert.match(result.stdout, /REVIEW INCOMPLETE/);
        assert.match(result.stdout, /Retry the review or ask a maintainer/);
      }
    });
  }
}
