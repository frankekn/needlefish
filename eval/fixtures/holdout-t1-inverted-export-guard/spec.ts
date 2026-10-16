import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-inverted-export-guard",
  kind: "positive",
  tier: 1,
  defectClass: "inverted-permission-check",
  holdout: true,
  description: "Synthetic archive export reverses its authorization guard and returns private data to accounts without export permission.",
  baseFiles: {
    "README.md": `Only accounts with canExport=true may receive the private archive. Others receive forbidden.
`,
    "archive.mjs": `export function exportArchive(account, privateArchive) {
  if (account.canExport) return privateArchive;
  throw new Error("forbidden");
}
`,
  },
  headFiles: {
    "archive.mjs": `export function exportArchive(account, privateArchive) {
  if (!account.canExport) return privateArchive;
  throw new Error("forbidden");
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "invert|revers|unauthoriz|without.{0,30}permission|permission.{0,30}(bypass|negat)|access.{0,20}(bypass|control)", file: "archive.mjs", lineRange: [2, 2] }],
    anchorFile: "archive.mjs",
    anchorLineRange: [2, 2],
  },
};

export default spec;
