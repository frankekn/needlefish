import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (W4). Never used while iterating on
// prompt wording - only run at final gates. See eval/RESULTS.md.
const spec: FixtureSpec = {
  id: "holdout-authorization-guard",
  kind: "positive",
  tier: 2,
  defectClass: "authorization-guard-weakened",
  holdout: true,
  description:
    "The diff weakens a delete permission check from requiring admin privileges within the tenant to allowing any tenant member to delete the record.",
  baseFiles: {
    "src/permissions.ts": `export interface Session {
  userId: string;
  tenantId: string;
  isAdmin: boolean;
}

export interface RecordRef {
  tenantId: string;
  ownerId: string;
}

export function canDeleteRecord(session: Session, record: RecordRef): boolean {
  return session.isAdmin && session.tenantId === record.tenantId;
}
`,
  },
  headFiles: {
    "src/permissions.ts": `export interface Session {
  userId: string;
  tenantId: string;
  isAdmin: boolean;
}

export interface RecordRef {
  tenantId: string;
  ownerId: string;
}

export function canDeleteRecord(session: Session, record: RecordRef): boolean {
  return session.isAdmin || session.tenantId === record.tenantId;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "authoriz|permission|privilege|weaken|escalat|any.{0,12}(tenant|member)|non.?admin|without.{0,12}admin|admin.{0,28}(check|guard|requir|bypass)|\\|\\|" },
    ],
    anchorFile: "src/permissions.ts",
    anchorLineRange: [10, 12],
  },
};

export default spec;
