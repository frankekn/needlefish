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
      { pattern: "invert|revers|flip|non.?admin|admin.{0,32}(forbidden|reject|blocked|cannot)|without.{0,12}admin|opposite" },
    ],
    anchorFile: "src/projects.ts",
    anchorLineRange: [11, 16],
  },
};

export default spec;
