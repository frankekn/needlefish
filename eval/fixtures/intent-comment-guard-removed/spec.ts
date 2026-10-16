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
      { pattern: "admin|role|authoriz|permission|privilege|any.{0,12}(caller|user)|forbidden|403|unauthenticat" },
    ],
    anchorFile: "src/server.ts",
    anchorLineRange: [6, 8],
  },
};

export default spec;
