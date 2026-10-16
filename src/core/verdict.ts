import type { Finding, ResidualRisk, Verdict } from "../shared/schema.js";

const BLOCKING: Finding["severity"][] = ["P0", "P1", "P2"];

export function deriveVerdict(
  findings: readonly Finding[],
  residualRisks: readonly ResidualRisk[]
): Verdict {
  const hasBlocking = findings.some((f) => BLOCKING.includes(f.severity));
  if (hasBlocking) return "changes_requested";
  const hasBlockingRisk = residualRisks.some((r) => r.blocks);
  if (hasBlockingRisk) return "needs_human";
  return "pass";
}

export function reviewExitCode(verdict: Verdict): 0 | 1 {
  return verdict === "pass" ? 0 : 1;
}
