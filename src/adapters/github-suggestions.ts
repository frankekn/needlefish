import type { Finding } from "../shared/schema.js";

export type DiffLineRange = readonly [number, number];

export type SuggestionFormatContext = {
  readonly ranges: ReadonlyMap<string, readonly DiffLineRange[]>;
  readonly headLineCount: () => number | null;
};

export type FormattedSuggestionComment = {
  readonly line: number;
  readonly startLine?: number;
  readonly body: string;
};

function rangeAnchorableIn(ranges: ReadonlyMap<string, readonly DiffLineRange[]>, finding: Finding): boolean {
  const fileRanges = ranges.get(finding.file);
  if (!fileRanges) return false;
  return fileRanges.some(([start, end]) => finding.lineStart >= start && finding.lineEnd <= end);
}

function validatedReplacementLines(
  finding: Finding,
  context: SuggestionFormatContext
): readonly string[] | null {
  const replacement = finding.replacement;
  if (!replacement) return null;
  if (!rangeAnchorableIn(context.ranges, finding)) return null;
  const lineCount = context.headLineCount();
  if (
    lineCount === null ||
    finding.lineStart > lineCount ||
    finding.lineEnd > lineCount ||
    replacement.lines.some((line) => /`{3,}/.test(line))
  ) {
    return null;
  }
  return replacement.lines;
}

function formatCommentBody(finding: Finding, replacementLines: readonly string[] | null): string {
  const lines = [
    `**${finding.severity}** ${finding.title}`,
    "",
    finding.whyItBreaks,
    "",
    `**Fix:** ${finding.suggestedFix}`,
  ];
  if (finding.validation) lines.push("", `**Validate:** ${finding.validation}`);
  if (replacementLines) lines.push("", "```suggestion", ...replacementLines, "```");
  return lines.join("\n");
}

export function formatSuggestionComment(
  finding: Finding,
  context: SuggestionFormatContext
): FormattedSuggestionComment {
  const replacementLines = validatedReplacementLines(finding, context);
  const body = formatCommentBody(finding, replacementLines);
  if (replacementLines && finding.lineEnd !== finding.lineStart) {
    return { line: finding.lineEnd, startLine: finding.lineStart, body };
  }
  return { line: finding.lineStart, body };
}
