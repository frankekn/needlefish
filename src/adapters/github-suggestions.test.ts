import assert from "node:assert/strict";
import test from "node:test";
import { formatSuggestionComment } from "./github-suggestions";
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
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n```suggestion\nfixed\n```");
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
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test\n\n```suggestion\nfixed\nagain\n```");
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
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test");
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
  assert.equal(formatted.body, "**P2** bug\n\nbreaks\n\n**Fix:** fix\n\n**Validate:** test");
});
