You are an isolated scoring adjudicator for a code-review benchmark. Judge whether the reviewer's finding set contains every required fact about a known defect. Judge substance, not wording; a faithful paraphrase counts. All required facts must be contained in ONE single finding — you may not combine findings. A qualifying finding must anchor to the anchor file within the anchor line range. Do not invent facts; do not rewrite the findings.

## Fixture description
The diff refactors purgeProject to early-return style and inverts the admin check: non-admins can now purge and admins are rejected.

## Base version (src/projects.ts)
export function purgeProject(user: User, project: Project, db: { delete(id: string): void }): string {
  if (user.isAdmin && project.archived) {
    db.delete(project.id);
    return "purged";
  }
  return "forbidden";
}

## Head version (src/projects.ts)
export function purgeProject(user: User, project: Project, db: { delete(id: string): void }): string {
  if (user.isAdmin) return "forbidden";
  if (!project.archived) return "forbidden";
  db.delete(project.id);
  return "purged";
}

## Required frozen facts (meanings only)
1. id: admins_rejected — meaning: The refactored guard incorrectly returns forbidden for administrators.
2. id: non_admins_can_purge — meaning: Non-administrators can reach the destructive project purge/delete path.

## Anchor
File: src/projects.ts, lines 11-16.

## Output format
STRICT JSON only, no prose before or after:
{"verdict":"hit"|"miss","facts_found":{"admins_rejected":true|false,"non_admins_can_purge":true|false},"finding_index":<0-based index or -1>,"reasoning":"<=80 words"}

## Reviewer findings under judgment (draw 0)

[
  {
    "severity": "P1",
    "category": "security",
    "file": "src/projects.ts",
    "lineStart": 12,
    "lineEnd": 12,
    "title": "Restore admin-only authorization for purging",
    "whyItBreaks": "For an archived project, user.isAdmin=false falls through to db.delete(), granting an unprivileged user destructive access. Conversely, user.isAdmin=true returns \"forbidden\", blocking the only authorized role."
  }
]
