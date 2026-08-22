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

test("deriveVerdict pins every severity boundary", () => {
  const residual = [{ text: "deep pass failed", blocks: true }];
  const cases: readonly {
    label: string;
    severity: Finding["severity"] | null;
    residualBlocks: boolean;
    expected: "changes_requested" | "needs_human" | "pass";
  }[] = [
    { label: "P0 alone", severity: "P0", residualBlocks: false, expected: "changes_requested" },
    { label: "P1 alone", severity: "P1", residualBlocks: false, expected: "changes_requested" },
    { label: "P2 alone", severity: "P2", residualBlocks: false, expected: "changes_requested" },
    { label: "P3 alone", severity: "P3", residualBlocks: false, expected: "pass" },
    { label: "blocking residual, no findings", severity: null, residualBlocks: true, expected: "needs_human" },
    { label: "blocking finding plus blocking residual", severity: "P2", residualBlocks: true, expected: "changes_requested" },
  ];

  for (const { label, severity, residualBlocks, expected } of cases) {
    const findings = severity === null ? [] : [{ ...finding, severity }];
    const residualRisks = residualBlocks ? residual : [];
    assert.equal(deriveVerdict(findings, residualRisks), expected, label);
  }
});
