import assert from "node:assert/strict";
import test from "node:test";
import { formatSuggestionComment } from "./github-suggestions";
import { isNeedlefishPost, OWN_POST_FINDING_MARKER } from "../shared/normalize";
import type { Finding } from "../shared/schema";

function mkFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "P2",
    title: "bug",
    category: "bug",
    file: "README.md",
    lineStart: 1,
    lineEnd: 1,
    confidence: 0.9,
    whyItBreaks: "breaks",
    suggestedFix: "fix",
    validation: "test",
    ...overrides,
  };
}

test("formatSuggestionComment emits exact suggestion block for valid single-line replacement", () => {
  const finding = mkFinding({ replacement: { lines: ["fixed"] } });

  const formatted = formatSuggestionComment(finding, {
    ranges: new Map([["README.md", [[1, 1]]]]),
    headLineCount: () => 1,
  });

  assert.equal(formatted.line, 1);
  assert.equal(formatted.startLine, undefined);
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n```suggestion\nfixed\n```\n\n<!-- needlefish-finding -->");
});

test("formatSuggestionComment preserves multiline replacement anchor data", () => {
  const finding = mkFinding({
    lineStart: 2,
    lineEnd: 3,
    replacement: { lines: ["fixed", "again"] },
  });

  const formatted = formatSuggestionComment(finding, {
    ranges: new Map([["README.md", [[2, 3]]]]),
    headLineCount: () => 3,
  });

  assert.equal(formatted.line, 3);
  assert.equal(formatted.startLine, 2);
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n```suggestion\nfixed\nagain\n```\n\n<!-- needlefish-finding -->");
});

test("formatSuggestionComment omits out-of-range replacement suggestions", () => {
  const finding = mkFinding({
    lineStart: 1,
    lineEnd: 2,
    replacement: { lines: ["fixed", "again"] },
  });

  const formatted = formatSuggestionComment(finding, {
    ranges: new Map([["README.md", [[1, 1]]]]),
    headLineCount: () => 2,
  });

  assert.equal(formatted.line, 1);
  assert.equal(formatted.startLine, undefined);
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n<!-- needlefish-finding -->");
});

test("formatSuggestionComment omits replacement suggestions containing three-plus backticks", () => {
  const finding = mkFinding({
    replacement: { lines: ['const fence = "```";'] },
  });

  const formatted = formatSuggestionComment(finding, {
    ranges: new Map([["README.md", [[1, 1]]]]),
    headLineCount: () => 1,
  });

  assert.equal(formatted.line, 1);
  assert.equal(formatted.startLine, undefined);
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n<!-- needlefish-finding -->");
});

test("formatSuggestionComment drops a suggestion that would exceed GitHub's body limit", () => {
  const finding = mkFinding({ replacement: { lines: ["x".repeat(70_000)] } });

  const formatted = formatSuggestionComment(finding, {
    ranges: new Map([["README.md", [[1, 1]]]]),
    headLineCount: () => 1,
  });

  assert.equal(formatted.line, 1);
  assert.equal(formatted.startLine, undefined);
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n<!-- needlefish-finding -->");
});

test("formatSuggestionComment shows the quote-check location note and stays silent on a match", () => {
  const context = { ranges: new Map([["README.md", [[1, 1]] as const]]), headLineCount: () => 1 };

  const moved = formatSuggestionComment(mkFinding({ quoteCheck: { status: "moved", from: "src/a.ts:9" } }), context);
  const missing = formatSuggestionComment(mkFinding({ quoteCheck: { status: "not_found" } }), context);
  const matched = formatSuggestionComment(mkFinding({ quoteCheck: { status: "matched" } }), context);

  assert.match(moved.body, /\*\*Validate:\*\* test\n\n_Location corrected from `src\/a\.ts:9`: the quoted source was found here\._\n/);
  assert.match(missing.body, /_Location unverified: the quoted source was not found in `README\.md`\._/);
  assert.equal(matched.body, formatSuggestionComment(mkFinding(), context).body);
});

test("formatSuggestionComment and isNeedlefishPost share the finding marker", () => {
  const formatted = formatSuggestionComment(mkFinding(), {
    ranges: new Map(),
    headLineCount: () => null,
  });
  const lastLine = formatted.body.split("\n").filter((line) => line.length > 0).at(-1);
  assert.equal(lastLine, OWN_POST_FINDING_MARKER);
  assert.equal(isNeedlefishPost(formatted.body, { bot: true, own: false }), true);
});

test("formatSuggestionComment suppresses replacements at unverified or relocated locations", () => {
 const context = { ranges: new Map([["README.md", [[1, 1]] as const]]), headLineCount: () => 1 };
 for (const quoteCheck of [{ status: "unchecked" }, { status: "not_found" }, { status: "moved", from: "old.ts:1" }] as const) {
  const comment = formatSuggestionComment(mkFinding({ replacement: { lines: ["fixed"] }, quoteCheck }), context);
  assert.equal(comment.body.includes("```suggestion"), false);
  assert.match(comment.body, /_Location /);
 }
});
