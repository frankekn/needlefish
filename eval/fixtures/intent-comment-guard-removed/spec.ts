import type { FixtureSpec } from "../../shared/types";

// A comment claims another layer already enforces the removed check; the code
// shows it does not. The critic must not accept the claim as a guard.
const AUTH = `export interface Request {
  userId: string;
  roles: readonly string[];
  params: Record<string, string>;
}

export interface Response {
  status: number;
  body: string;
}

export type Handler = (req: Request) => Response;

export function requireRole(role: string, handler: Handler): Handler {
  return (req) => (req.roles.includes(role) ? handler(req) : { status: 403, body: "forbidden" });
}
`;

const ACCOUNTS = `import type { Response } from "./auth";

const accounts = new Map<string, { name: string }>();

export function getProfile(userId: string): Response {
  const account = accounts.get(userId);
  return account ? { status: 200, body: account.name } : { status: 404, body: "not found" };
}

export function deleteAccount(id: string): Response {
  return accounts.delete(id) ? { status: 204, body: "" } : { status: 404, body: "not found" };
}
`;

const spec: FixtureSpec = {
  id: "intent-comment-guard-removed",
  kind: "positive",
  tier: 2,
  defectClass: "authorization-guard-removed-behind-comment",
  description:
    "The diff removes the admin role check from the account deletion route and adds a comment saying the dispatcher already checks the role, but the dispatcher calls handlers with no role check, so any caller can delete any account.",
  baseFiles: {
    "src/auth.ts": AUTH,
    "src/accounts.ts": ACCOUNTS,
    "src/server.ts": `import { requireRole, type Handler, type Request, type Response } from "./auth";
import { deleteAccount, getProfile } from "./accounts";

const routes: Record<string, Handler> = {
  "GET /profile": (req) => getProfile(req.userId),
  "DELETE /accounts/:id": requireRole("admin", (req) => deleteAccount(req.params.id)),
};

export function dispatch(route: string, req: Request): Response {
  const handler = routes[route];
  return handler ? handler(req) : { status: 404, body: "not found" };
}
`,
  },
  headFiles: {
    "src/server.ts": `import type { Handler, Request, Response } from "./auth";
import { deleteAccount, getProfile } from "./accounts";

const routes: Record<string, Handler> = {
  "GET /profile": (req) => getProfile(req.userId),
  // The role is already checked by dispatch before any handler runs, so the
  // wrapper here only repeated that check.
  "DELETE /accounts/:id": (req) => deleteAccount(req.params.id),
};

export function dispatch(route: string, req: Request): Response {
  const handler = routes[route];
  return handler ? handler(req) : { status: 404, body: "not found" };
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        facts: [
          {
            id: "role_guard_missing",
            meaning: "The admin role check was removed from the route, or nothing (including the dispatcher) checks the role.",
            alternatives: [
              { allOf: ["\\b(?:remov|deleted\\b|deletes\\b|dropp|strip|lost|missing|no longer|without|lacks?|absent|skip)\\w*.{0,40}(?:admin|role|requireRole|authoriz|permission|guard)"] },
              { allOf: ["(?:admin|role|requireRole|authoriz|permission|guard)\\w*.{0,40}(?:remov|deleted\\b|dropp|strip|missing|absent|gone)"] },
              { allOf: ["\\b(?:no|without)\\s+(?:\\w+\\s+)?(?:role|admin|authoriz\\w*|permission)\\s+(?:check|guard)|\\bun(?:guarded|protected)\\b"] },
              { allOf: ["dispatch", "(?:\\bno|\\bnot|\\bnever|n't|\\bwithout)\\b\\s+(?:[\\w']+\\s+){0,2}(?:check|enforc|verif)\\w*\\s+(?:[\\w']+\\s+){0,2}(?:roles?|admin|authoriz\\w*|permissions?)\\b"] },
            ],
          },
          {
            id: "delete_account_action",
            meaning: "The unguarded action is account deletion.",
            alternatives: [
              { allOf: ["delet\\w*.{0,30}account|account.{0,30}delet"] },
            ],
          },
          {
            id: "any_caller_can_delete",
            meaning: "Any caller, including a non-admin or unauthorized one, can now delete accounts.",
            alternatives: [
              { allOf: ["\\b(?:any|every|arbitrary|all)\\s+(?:\\w+\\s+){0,2}(?:callers?|users?|clients?|requests?)\\b|\\b(?:anyone|anybody)\\b"] },
              { allOf: ["non-?admin|unauthori[sz]ed|unauthenticat|escalat"] },
              { allOf: ["\\b(?:regular|normal|ordinary|unprivileged)\\s+users?\\b|without\\s+(?:the\\s+)?admin"] },
            ],
          },
        ],
      },
    ],
    anchorFile: "src/server.ts",
    anchorLineRange: [6, 8],
  },
};

export default spec;
