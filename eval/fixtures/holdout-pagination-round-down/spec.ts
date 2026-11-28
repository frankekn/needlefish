import type { FixtureSpec } from "../../shared/types";

// Appended consequence alternatives are keyword conjunctions, so each also
// requires that the finding never denies a loss ("never skip the final page",
// "no pages are lost", "not an undercount", "does not return zero pages").
const NO_DENIED_LOSS =
  "^(?![\\s\\S]*\\b(?:no|not|never|nothing|none|isn't|aren't|doesn't|does not|don't|won't)\\s+(?:\\w+\\s+){0,3}(?:lost|loses?|losing|drop\\w*|skip\\w*|miss\\w*|omit\\w*|exclud\\w*|ignor\\w*|truncat\\w*|cut off|left out|undercount\\w*|off[- ]by[- ]one|short\\b|(?:return|yield|giv|report|produc|comput|evaluat|result)\\w*\\s+(?:in\\s+|to\\s+)?(?:0|zero|no)\\b))";

// HOLDOUT: sealed at authoring time. Never run during iteration; first model
// exposure is the holdout-included final production gate.
const spec: FixtureSpec = {
  id: "holdout-pagination-round-down",
  kind: "positive",
  tier: 2,
  defectClass: "pagination-rounds-down",
  holdout: true,
  description:
    "The diff changes a pagination page-count calculation from ceiling to floor, dropping the final partial page and reporting zero pages when the item count is below one page.",
  baseFiles: {
    "src/pagination.ts": `export function pageCount(totalItems: number, pageSize: number): number {
  if (pageSize <= 0) throw new Error("pageSize must be positive");
  return Math.ceil(totalItems / pageSize);
}
`,
  },
  headFiles: {
    "src/pagination.ts": `export function pageCount(totalItems: number, pageSize: number): number {
  if (pageSize <= 0) throw new Error("pageSize must be positive");
  return Math.floor(totalItems / pageSize);
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        facts: [
          {
            id: "page_count_rounds_down",
            meaning: "The page count rounds down instead of up.",
            alternatives: [
              { allOf: ["page", "(?:round|floor).{0,12}down"] },
              { allOf: ["page", "Math\\.floor"] },
              { allOf: ["Math\\.ceil", "Math\\.floor"] },
              // Appended 2026-11-28 by a transcript-blind curator from the description, diff and frozen fact meanings (no findings or scores seen).
              // Each one needs the ceiling/floor change or the floored division itself, not just pagination wording.
              {
                allOf: [
                  "page(?:Count| count|s\\b)",
                  "\\bceil(?:ing)?\\b.{0,40}\\bfloor(?:s|ed|ing)?\\b|\\bfloor(?:s|ed|ing)?\\b.{0,40}\\bceil(?:ing)?\\b",
                ],
              },
              {
                allOf: [
                  "page(?:Count| count|s\\b)",
                  "\\bfloor(?:s|ed|ing)?\\b",
                  "(?:totalItems\\s*/\\s*pageSize|\\d+\\s*/\\s*\\d+|quotient|division|divid\\w+)",
                ],
              },
              {
                allOf: [
                  "page(?:Count| count|s\\b)",
                  "\\b(?:truncat\\w*|integer division)",
                  "(?:totalItems\\s*/\\s*pageSize|\\d+\\s*/\\s*\\d+|quotient|division|divid\\w+)",
                ],
              },
              {
                allOf: [
                  "page(?:Count| count|s\\b)",
                  "\\bround\\w*\\b.{0,40}\\b(?:down(?:ward)?|toward(?:s)? zero)\\b",
                  "count|total|number|quotient|division|divid\\w+|\\d+\\s*/\\s*\\d+",
                ],
              },
              {
                allOf: [
                  "page(?:Count| count|s\\b)",
                  "\\b(?:no longer|not|stop\\w*|instead of|rather than|without)\\W+(?:\\w+\\W+){0,4}?(?:round\\w*\\W+up\\b|ceil\\w*)",
                  "count|total|number|quotient|division|divid\\w+|\\d+\\s*/\\s*\\d+",
                ],
              },
            ],
          },
          {
            id: "partial_page_is_lost",
            meaning: "A remainder/partial final page is omitted or a small result becomes zero pages.",
            alternatives: [
              { allOf: ["(?:partial|last|final)", "page", "(?:drop|omit|miss|lose|lost)"] },
              { allOf: ["remainder", "page"] },
              { allOf: ["zero", "page", "(?:fewer|less|below|under)"] },
              // Appended 2026-11-28 by a transcript-blind curator from the description, diff and frozen fact meanings (no findings or scores seen).
              // Each one needs a concrete lost-page/lost-item claim, not just floor or pagination wording.
              {
                allOf: [
                  "pages?\\b",
                  "\\b(?:trailing|leftover|remaining|remainder|extra|excess|overflow|last|final)\\s+(?:\\w+\\s+){0,2}(?:items?|rows?|records?|results?|entries)",
                  "\\b(?:unreachable|inaccessible|invisible|hidden|never\\s+(?:\\w+\\s+){0,2}(?:shown|reached|returned|rendered|displayed|fetched|visited|listed|requested)|(?:cannot|can't|can not|can no longer|no longer|not|won't)\\s+(?:\\w+\\s+){0,2}(?:reach\\w*|fetch\\w*|view\\w*|see\\w*|access\\w*|shown|displayed|visible|listed|retrieved|paged|rendered))",
                  NO_DENIED_LOSS,
                ],
              },
              {
                allOf: [
                  "\\b(?:callers?|consumers?|clients?|UI|loops?|iterat\\w+|fetch\\w*|walk\\w*|page through|users?)\\b",
                  "pageCount|page count|number of pages|total pages|page total",
                  "\\b(?:never\\s+(?:\\w+\\s+){0,2}(?:reach|see|fetch|get|request|render|visit|display|show)\\w*|stops? (?:before|short)|skips?|misses?|cannot|can't|won't|short of|ends? (?:before|short))\\b",
                  "\\b(?:last|final|trailing|remaining|leftover|partial|remainder|extra)\\s+(?:\\w+\\s+){0,2}(?:page|items?|rows?|records?|results?|entries)",
                  NO_DENIED_LOSS,
                ],
              },
              {
                allOf: [
                  "(?:\\b(?:returns?|returning|yields?|gives?|reports?|produces?|becomes?|results? in|computes?|evaluates to|shows?)|=|→|->)\\s+(?:\\w+\\s+){0,1}(?:0|zero|no)\\s+pages?\\b|\\b(?:0|zero)\\s+pages?\\s+(?:instead of|rather than|for (?:a|an|any|one|\\d))",
                  "\\b(?:smaller|fewer|less|below|under|short|single|partial|only|small\\w*|[a-z]+\\s+than)\\b.{0,40}(?:page ?size|per page|one page|a full page|a page|items?|rows?|records?|results?|entries)",
                  NO_DENIED_LOSS,
                ],
              },
              {
                allOf: [
                  "pageCount\\(\\s*[1-9]\\d*\\s*,\\s*[1-9]\\d*\\s*\\)",
                  "(?:\\b(?:returns?|yields?|gives?|evaluates to|results? in|produces?|reports?)|=|→|->)\\s*(?:0|zero)\\b",
                  NO_DENIED_LOSS,
                ],
              },
              {
                allOf: [
                  "\\b(?:partial|last|final|trailing|remaining|leftover|incomplete|remainder)\\s+(?:\\w+\\s+){0,1}page",
                  "(?:\\b(?:not|never|isn't|aren't|no longer|won't|doesn't|does not)\\s+(?:\\w+\\s+){0,2}(?:counted|included|reported|returned|shown|displayed|reach\\w*|fetched|accounted|covered|rendered|listed)|\\b(?:excluded|ignored|skipped|truncated|cut off|left out|uncounted|unreachable))",
                  NO_DENIED_LOSS,
                ],
              },
              {
                allOf: [
                  "pages?\\b",
                  "(?:undercount\\w*|one (?:page )?(?:too )?(?:few|short|less)|short by (?:one|1)|off[- ]by[- ]one|\\b(?:one|1) fewer)",
                  "(?:evenly|divisible|multiple of|remainder|leftover|not exact\\w*|uneven)",
                  NO_DENIED_LOSS,
                ],
              },
            ],
          },
        ],
      },
    ],
    anchorFile: "src/pagination.ts",
    anchorLineRange: [1, 4],
  },
};

export default spec;
