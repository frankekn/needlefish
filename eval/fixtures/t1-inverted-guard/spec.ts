import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "t1-inverted-guard",
  kind: "positive",
  tier: 1,
  defectClass: "inverted-permission-check",
  description:
    "The diff refactors purgeProject to early-return style and inverts the admin check: non-admins can now purge and admins are rejected. Blatant; a reviewer that misses this is disqualified.",
  baseFiles: {
    "src/projects.ts": `export interface User {
  id: string;
  isAdmin: boolean;
}

export interface Project {
  id: string;
  archived: boolean;
}

export function purgeProject(user: User, project: Project, db: { delete(id: string): void }): string {
  if (user.isAdmin && project.archived) {
    db.delete(project.id);
    return "purged";
  }
  return "forbidden";
}
`,
  },
  headFiles: {
    "src/projects.ts": `export interface User {
  id: string;
  isAdmin: boolean;
}

export interface Project {
  id: string;
  archived: boolean;
}

export function purgeProject(user: User, project: Project, db: { delete(id: string): void }): string {
  if (user.isAdmin) return "forbidden";
  if (!project.archived) return "forbidden";
  db.delete(project.id);
  return "purged";
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        facts: [
          {
            id: "admins_rejected",
            meaning: "The refactored guard incorrectly returns forbidden for administrators.",
            alternatives: [
              { allOf: ["user\\.isAdmin", "return\\s+[\"']forbidden[\"']"] },
              { allOf: ["\\badmins?\\b", "\\b(?:forbidden|rejected|blocked)\\b"] },
              { allOf: ["\\badministrators?\\b", "\\b(?:forbidden|rejected|blocked|denied)\\b"] },
              { allOf: ["admin(?:istrator)?\\s+(?:check|guard)", "\\binvert(?:ed|s|ing)\\b", "\\b(?:forbidden|rejected|blocked|denied)\\b"] },
              { allOf: ["if\\s*\\(\\s*user\\.isAdmin\\s*\\)", "return\\s+[\"']forbidden[\"']"] },
              // Description: "admins are rejected". Reviewers also state the same
              // fact as the truth value the guard tests: "isAdmin is true" /
              // "isAdmin=true" is rejected, forbidden, or returned early.
              { allOf: ["isAdmin\\s*(?:[:=]+|is)\\s*true", "\\b(?:forbidden|reject(?:s|ed|ing)?|blocked|denied|early return|returns? early)\\b"] },
            ],
          },
          {
            id: "non_admins_can_purge",
            meaning: "Non-administrators can reach the destructive project purge/delete path.",
            alternatives: [
              { allOf: ["non[- ]?admins?", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              { allOf: ["without\\s+admin", "db\\.delete"] },
              { allOf: ["unauthori[sz]ed\\s+users?", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              { allOf: ["not\\s+(?:an?\\s+)?admin(?:istrator)?", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              { allOf: ["users?\\s+(?:without|lacking)\\s+admin(?:istrator)?\\s+(?:rights|permissions|privileges|access)", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              { allOf: ["if\\s*\\(\\s*user\\.isAdmin\\s*\\)\\s*return\\s+[\"']forbidden[\"']", "db\\.delete\\s*\\("] },
              { allOf: ["user\\.isAdmin\\s*(?:===?\\s*false|is\\s+false)", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              // Description: "non-admins can now purge" stated as a negation of
              // admin: "any non-admin", "a non-admin ... deletes", "without being an
              // admin", "regardless of admin".
              { allOf: ["\\b(?:any|a|every)\\s+non[- ]?admin", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              { allOf: ["\\b(?:without being|regardless of)\\s+(?:an?\\s+)?admin", "\\b(?:purge|delete)(?:s|d|ing)?\\b"] },
              // Description: "inverts the admin check" so the destructive branch is
              // reached by callers the old guard rejected. The actor must be named
              // in the same finding: a non-admin, or isAdmin false, falls through
              // to / reaches / runs db.delete.
              { allOf: ["(?:non[- ]?admin|isAdmin\\s*[:=]+\\s*false|isAdmin\\s+is\\s+false|not\\s+(?:an?\\s+)?admin)", "\\b(?:falls? through|fall through|reach(?:es|ed)?|proceeds? to|runs?)\\b", "db\\.delete"] },
            ],
          },
        ],
      },
    ],
    anchorFile: "src/projects.ts",
    anchorLineRange: [11, 16],
  },
};

export default spec;
