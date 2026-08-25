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
