import type { Verdict } from "./schema.js";

// Delivery policy only: keep model output and deriveVerdict unchanged.
// GitHub accepts neutral required checks, so needs_human must fail closed.
export function reviewStatus(verdict: Verdict): {
  readonly exitCode: 0 | 1;
  readonly conclusion: "success" | "failure";
} {
  return verdict === "pass"
    ? { exitCode: 0, conclusion: "success" }
    : { exitCode: 1, conclusion: "failure" };
}
