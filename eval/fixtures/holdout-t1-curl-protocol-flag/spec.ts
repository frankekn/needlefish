import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-t1-curl-protocol-flag",
  kind: "positive",
  tier: 1,
  defectClass: "missing-security-flag",
  holdout: true,
  description: "Synthetic remote fetcher removes the HTTPS protocol restriction and accepts local file URLs.",
  baseFiles: {
    "README.md": `fetch.sh receives a caller-supplied URL as its first argument. Only HTTPS is allowed. The caller receives the fetched body. Local file URLs must never disclose host files.
`,
    "fetch.sh": `#!/bin/sh
set -eu
exec curl --silent --show-error --proto '=https' "$1"
`,
  },
  headFiles: {
    "fetch.sh": `#!/bin/sh
set -eu
exec curl --silent --show-error "$1"
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "protocol|--proto|file.{0,20}(URL|read|disclos)|local.{0,20}file|HTTPS|SSRF", file: "fetch.sh", lineRange: [3, 3] }],
    anchorFile: "fetch.sh",
    anchorLineRange: [3, 3],
  },
};

export default spec;
