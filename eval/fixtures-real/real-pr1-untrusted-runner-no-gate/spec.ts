// Real-PR fixture (curated from review-thread evidence, NOT the code diff).
// mustFind patterns below were derived from the reviewer's own wording in the
// linked PR thread per eval/fixtures-real/README.md step 4 -- never from
// reverse-engineering the diff. Patterns commander-reviewed 2026-07-10.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr1-untrusted-runner-no-gate",
  kind: "positive",
  tier: 2,
  defectClass: "untrusted-code-on-persistent-runner",
  description:
    "Real PR (rejected in review): the pull_request workflow checks out the PR head and runs pnpm install on a persistent self-hosted runner with no fork/same-repo gate, so a PR can change install scripts or repo code and execute arbitrary commands on the persistent host before review logic even runs. Source: https://github.com/frankekn/needlefish/pull/1#discussion_r3479967293.",
  baseFiles: {
    ".github/workflows/review.yml": "name: needlefish-review\n\n# Self-review mode: this repo IS needlefish, so the PR checkout's own src/ is\n# the tool. For OTHER repos, use the generic template in README.md (which adds a\n# second checkout of frankekn/needlefish as the tool).\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n\npermissions:\n  contents: read\n  pull-requests: write\n  checks: write\n\njobs:\n  review:\n    runs-on: self-hosted\n    if: github.event.pull_request.head.repo.full_name == github.repository\n    steps:\n      - name: Checkout PR head\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          fetch-depth: 0\n\n      - name: Install\n        shell: zsh -l {0}\n        run: corepack enable && pnpm install --frozen-lockfile\n\n      - name: Needlefish review\n        shell: zsh -l {0}\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        run: ./node_modules/.bin/tsx src/cli.ts --github --pr ${{ github.event.pull_request.number }}\n",
  },
  headFiles: {
    ".github/workflows/review.yml": "name: needlefish-review\n\n# Self-review mode: this repo IS needlefish, so the PR checkout's own src/ is\n# the tool. For OTHER repos, use the generic template in README.md (which adds a\n# second checkout of frankekn/needlefish as the tool).\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n\npermissions:\n  contents: read\n  pull-requests: write\n  checks: write\n\njobs:\n  review:\n    runs-on: self-hosted\n    steps:\n      - name: Checkout PR head\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha }}\n          fetch-depth: 0\n\n      - name: Install\n        shell: zsh -l {0}\n        run: corepack enable && pnpm install --frozen-lockfile\n\n      - name: Needlefish review\n        shell: zsh -l {0}\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        run: ./node_modules/.bin/tsx src/cli.ts --github --pr ${{ github.event.pull_request.number }}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "self.?hosted|persistent.{0,20}(runner|host|machine)|fork|untrusted.{0,20}(code|pr)|isolat|ephemeral|gate.{0,20}(repo|branch|author)" },
    ],
    anchorFile: ".github/workflows/review.yml",
  },
  provenance: { repo: "frankekn/needlefish", pr: 1, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/1#discussion_r3479967293", fixSha: "5db438c448e5529686ab145d9212efd74d744145" },
};

export default spec;
