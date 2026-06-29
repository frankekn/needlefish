import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "sql-safe-index",
  kind: "negative",
  defectClass: "safe-additive-index",
  description: "A new migration adds a non-unique index on an existing column. No contract or behavior break.",
  baseFiles: {
    "migrations/0001_init.sql": `CREATE TABLE users (id SERIAL PRIMARY KEY, email TEXT);
`,
  },
  headFiles: {
    "migrations/0002_index.sql": `CREATE INDEX idx_users_email ON users(email);
`,
  },
  expected: {
    verdict: "pass",
    noBlockingFindings: true,
  },
};

export default spec;
