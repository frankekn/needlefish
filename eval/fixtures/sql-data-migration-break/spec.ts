import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "sql-data-migration-break",
  kind: "positive",
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
    mustFind: [
      { pattern: "migrat|rename|column|email|contact_email|select|query|stale|break" },
    ],
    anchorFile: "src/query.sql",
  },
};

export default spec;
