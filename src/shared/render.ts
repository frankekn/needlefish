import type { ReviewResult, Severity } from "./schema";

const SEV_ORDER: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

const VERDICT_BADGE: Record<string, string> = {
  pass: "✅ pass",
  changes_requested: "⛔ changes_requested",
  needs_human: "👀 needs_human",
};

export function renderMarkdown(result: ReviewResult): string {
  const lines: string[] = [];
  lines.push("# Needlefish PR Review");
  lines.push("");
  lines.push(`**Verdict:** ${VERDICT_BADGE[result.verdict] ?? result.verdict}`);
  lines.push(`**Base:** ${result.baseSha}  →  **Head:** ${result.headSha}`);
  if (result.reviewTarget) lines.push(...result.reviewTarget.split("\n"));
  if (result.summary) lines.push("");
  if (result.summary) lines.push(result.summary);
  lines.push("");

  const findings = [...result.findings].sort(
    (a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]
  );

  if (findings.length === 0) {
    lines.push("## Findings");
    lines.push("");
    lines.push("No actionable findings. Prefer this over padding weak ones.");
  } else {
    lines.push("## Findings");
    lines.push("");
    for (const f of findings) {
      lines.push(`### ${f.severity}: ${f.title}`);
      lines.push(
        `${f.file || "(no file)"}:${f.lineStart}${
          f.lineEnd && f.lineEnd !== f.lineStart ? `-${f.lineEnd}` : ""
        }`
      );
      lines.push("");
      lines.push(`**Why this breaks:** ${f.whyItBreaks}`);
      lines.push("");
      lines.push(`**Suggested fix:** ${f.suggestedFix}`);
      if (f.validation) {
        lines.push("");
        lines.push(`**Validation:** \`${f.validation}\``);
      }
      lines.push("");
    }
  }

  if (result.checked.length > 0) {
    lines.push("## Checked");
    lines.push("");
    for (const c of result.checked) lines.push(`- ${c}`);
    lines.push("");
  }

  if (result.residualRisks.length > 0) {
    lines.push("## Residual Risk");
    lines.push("");
    for (const r of result.residualRisks) {
      lines.push(`- ${r.blocks ? "⛔ " : ""}${r.text}`);
    }
  }

  return lines.join("\n").trim() + "\n";
}
