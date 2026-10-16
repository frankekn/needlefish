import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-untrusted-auditor-ref",
  kind: "positive",
  tier: 1,
  defectClass: "untrusted-self-review-tool-checkout",
  holdout: true,
  description: "Synthetic policy audit executes the proposal author's replacement auditor instead of the trusted pinned auditor.",
  baseFiles: {
    "README.md": `audit.sh receives independently pinned trusted and proposal Git commit IDs as arguments 1 and 2, and a manifest path as argument 3. The caller resolves these IDs before execution. Only the trusted auditor may decide whether a manifest can publish. Proposal authors control every file in their commit.
`,
    "audit.sh": `#!/bin/sh
set -eu
exec python3 -c "$(git show "$1:tools/audit.py")" "$3"
`,
  },
  headFiles: {
    "audit.sh": `#!/bin/sh
set -eu
exec python3 -c "$(git show "$2:tools/audit.py")" "$3"
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "untrusted|self.?review|self.?approv|proposal.{0,35}(audit|code|control)|attacker|trusted.{0,20}(ref|commit|audit)", file: "audit.sh", lineRange: [3, 3] }],
    anchorFile: "audit.sh",
    anchorLineRange: [3, 3],
  },
};

export default spec;
