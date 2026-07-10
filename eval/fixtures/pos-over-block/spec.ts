import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "pos-over-block",
  kind: "positive",
  tier: 2,
  defectClass: "over-block-viewer-dead-branch",
  description: "Agent hardens isEligible by rejecting viewers, but handle has a legitimate viewer read-only branch that is now unreachable. Includes a benign tooMany extraction as noise.",
  baseFiles: {
    "src/handler.ts": `export type Status = "draft" | "pending" | "active" | "closed";
export type Role = "viewer" | "editor" | "admin";

export interface Request {
  status: Status;
  role: Role;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

export function isEligible(req: Request): boolean {
  if (req.status !== "active") return false;
  if (req.attempts >= MAX_ATTEMPTS) return false;
  return true;
}

export function handle(req: Request): string {
  if (!isEligible(req)) return "rejected";
  if (req.role === "viewer") return "read-only";
  if (req.role === "admin") return "elevated";
  return "processed";
}
`,
  },
  headFiles: {
    "src/handler.ts": `export type Status = "draft" | "pending" | "active" | "closed";
export type Role = "viewer" | "editor" | "admin";

export interface Request {
  status: Status;
  role: Role;
  attempts: number;
}

const MAX_ATTEMPTS = 5;

function tooMany(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS;
}

export function isEligible(req: Request): boolean {
  if (req.status !== "active") return false;
  if (req.role === "viewer") return false;
  if (tooMany(req.attempts)) return false;
  return true;
}

export function handle(req: Request): string {
  if (!isEligible(req)) return "rejected";
  if (req.role === "viewer") return "read-only";
  if (req.role === "admin") return "elevated";
  return "processed";
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "viewer|over.?block|unreachable|dead|read.?only|reject.*path|eligible|never.*reach" },
    ],
    anchorFile: "src/handler.ts",
    anchorLineRange: [16, 21],
  },
};

export default spec;
