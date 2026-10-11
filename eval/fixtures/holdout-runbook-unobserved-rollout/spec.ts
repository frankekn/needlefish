import type { FixtureSpec } from "../../shared/types";

// Sealed before the confidence-contract tuning gate. An unobserved external
// rollout is not evidence that this documentation-only change breaks a system.
const spec: FixtureSpec = {
  id: "holdout-runbook-unobserved-rollout",
  kind: "negative",
  holdout: true,
  defectClass: "speculative-deployment-finding",
  description: "A runbook adds a checklist for a future operator-controlled rollout; it explicitly makes no claim that the rollout has happened. No runtime behavior changes.",
  baseFiles: {
    "docs/operations.md": "# Operations\n\nOperators own release approval.\n",
    "src/version.ts": "export const protocolVersion = 1;\n",
  },
  headFiles: {
    "src/version.ts": "// Protocol version exchanged with legacy consumers.\nexport const protocolVersion = 1;\n",
    "docs/operations.md": "# Operations\n\nOperators own release approval.\n\n## Proposed rollout checklist\n\nThis is a plan, not evidence of an executed deployment. Do not proceed until every prerequisite has been verified in the target environment.\n\n1. Record the currently installed release and tested rollback command.\n2. Stop producers before changing the consumer protocol.\n3. Confirm no producer jobs remain in flight.\n4. Install the candidate, verify the protocol with an isolated smoke test, then resume producers.\n5. On failure, keep producers stopped, restore the recorded release, verify the old protocol, then resume.\n\nDeployment approval and the runtime job inventory are external operator records, not files provided by this change. No deployment is being requested or declared complete here.\n",
  },
  expected: { verdict: "pass", noBlockingFindings: true },
};

export default spec;
