import { quoteNote } from "../shared/render.js";
import { OWN_POST_FINDING_MARKER } from "../shared/normalize.js";
import type { Finding } from "../shared/schema.js";

export type DiffLineRange = readonly [number, number];

// GitHub rejects a review or comment body over 65,536 characters (#215).
export const GH_BODY_CHAR_LIMIT = 65_536;

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
  if (finding.quoteCheck && finding.quoteCheck.status !== "matched") return null;
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
  const note = quoteNote(finding);
  if (note) lines.push("", note);
  if (replacementLines) lines.push("", "```suggestion", ...replacementLines, "```");
  lines.push("", OWN_POST_FINDING_MARKER);
  return lines.join("\n");
}

export function formatSuggestionComment(
  finding: Finding,
  context: SuggestionFormatContext
): FormattedSuggestionComment {
  let replacementLines = validatedReplacementLines(finding, context);
  let body = formatCommentBody(finding, replacementLines);
  // A suggestion GitHub would only receive truncated is no longer the validated
  // replacement, and the cut leaves its fence open. Post the plain comment.
  if (replacementLines && body.length > GH_BODY_CHAR_LIMIT) {
    replacementLines = null;
    body = formatCommentBody(finding, null);
  }
  if (replacementLines && finding.lineEnd !== finding.lineStart) {
    return { line: finding.lineEnd, startLine: finding.lineStart, body };
  }
  return { line: finding.lineStart, body };
}
