import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "sql-data-migration-break",
  kind: "positive",
  tier: 2,
  defectClass: "migration-rename-misses-reader",
  description: "A new migration renames the email column to contact_email, but the existing query reader still selects the old column name and breaks at runtime.",
  baseFiles: {
    "migrations/0001_init.sql": `ALTER TABLE users ADD COLUMN email TEXT;
`,
    "src/query.sql": `SELECT email FROM users;
`,
  },
  headFiles: {
    "migrations/0002_rename.sql": `ALTER TABLE users RENAME COLUMN email TO contact_email;
`,
  },
  expected: {
    verdict: "changes_requested",
    // Cross-file fixture: a correct finding legitimately anchors at either
    // the migration (the change) or src/query.sql (the breakage site) — the
    // 2026-07-09 strict-scorer baseline showed codex anchoring the correct
    // finding at the migration file on 3/3 draws. No anchorFile on purpose;
    // the pattern is tightened to compensate (multi-word alternatives only).
    mustFind: [
      { pattern: "contact_email|email column|stale.{0,12}(query|select)|query.{0,32}(fail|break|stale)|select email|renam.{0,24}column|column.{0,24}renam" },
    ],
  },
};

export default spec;
