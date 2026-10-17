import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-table-options",
  kind: "positive",
  tier: 2,
  holdout: true,
  defectClass: "option-forwarding",
  description: "Extracting a text table formatter overwrites two caller options at the helper call. includeHeader=false still emits the header, and maxRows=1 still emits every row. Both options worked before the refactor and are independent contracts.",
  baseFiles: {
    "README.md": `# Text table

renderTable(rows, options) formats name/count pairs as tab-separated text.
includeHeader defaults to true. Set it to false to omit the name/count header.
maxRows defaults to all rows. Set it to a nonnegative integer to cap data rows.
The header does not count toward maxRows. Empty output is an empty string.
`,
    "src/table.js": `export function renderTable(rows, options = {}) {
  const { includeHeader = true, maxRows = rows.length } = options;
  const lines = rows.slice(0, maxRows).map(([name, count]) => name + "\\t" + count);
  if (includeHeader) lines.unshift("name\\tcount");
  return lines.join("\\n");
}
`,
  },
  headFiles: {
    "src/table.js": `function formatRows(rows, options) {
  const { includeHeader = true, maxRows = rows.length } = options;
  const lines = rows.slice(0, maxRows).map(([name, count]) => name + "\\t" + count);
  if (includeHeader) lines.unshift("name\\tcount");
  return lines.join("\\n");
}

export function renderTable(rows, options = {}) {
  return formatRows(rows, {
    ...options,
    includeHeader: true,
    maxRows: rows.length,
  });
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        pattern: "(?=[\\s\\S]*(?:includeHeader|header|heading))(?=[\\s\\S]*(?:false|disabl|omit|suppress|unwanted|always|forc|ignor|overrid))",
        file: "src/table.js",
        lineRange: [9, 12],
      },
      {
        pattern: "(?=[\\s\\S]*(?:maxRows|row.{0,15}(?:limit|cap)|(?:limit|cap).{0,15}row))(?=[\\s\\S]*(?:all|every|ignor|overrid|exceed|unlimit|discard|lost|honor|honour))",
        file: "src/table.js",
        lineRange: [9, 12],
      },
    ],
    anchorFile: "src/table.js",
    anchorLineRange: [9, 12],
  },
};

export default spec;
