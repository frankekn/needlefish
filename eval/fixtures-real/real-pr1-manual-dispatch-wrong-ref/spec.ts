// Real-PR fixture (curated from review-thread evidence, NOT the code diff).
// mustFind patterns below were derived from the reviewer's own wording in the
// linked PR thread per eval/fixtures-real/README.md step 4 -- never from
// reverse-engineering the diff. Patterns commander-reviewed 2026-07-10.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr1-manual-dispatch-wrong-ref",
  kind: "positive",
  tier: 2,
  defectClass: "manual-dispatch-wrong-ref",
  description:
    "Real PR (rejected in review): on workflow_dispatch there is no github.event.pull_request, so checkout falls back to github.ref (usually main) and BASE_REF falls back to 'main', while the run step still passes the input PR number -- so a manual review inspects the wrong branch (often an empty diff) instead of the requested PR. Source: https://github.com/frankekn/needlefish/pull/1#discussion_r3480470296.",
  baseFiles: {
    ".github/workflows/review.yml": "name: needlefish-review\n\n# Self-review mode: this repo IS needlefish, so the PR checkout's own src/ is\n# the tool. For OTHER repos, use the generic template in README.md (which adds a\n# second checkout of frankekn/needlefish as the tool).\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch:\n    inputs:\n      pr_number:\n        description: PR number to review (manual trigger; bypasses pull_request webhook)\n        required: true\n\npermissions:\n  contents: read\n  pull-requests: write\n  checks: write\n\njobs:\n  review:\n    runs-on: self-hosted\n    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository\n    steps:\n      - name: Resolve PR refs\n        id: refs\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          PR_NUM: ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n          EVENT_HEAD: ${{ github.event.pull_request.head.sha }}\n          EVENT_BASE: ${{ github.event.pull_request.base.sha }}\n          EVENT_BASE_REF: ${{ github.event.pull_request.base.ref }}\n        run: |\n          if [ -n \"$EVENT_HEAD\" ]; then\n            echo \"head=$EVENT_HEAD\"      >> \"$GITHUB_OUTPUT\"\n            echo \"base=$EVENT_BASE\"      >> \"$GITHUB_OUTPUT\"\n            echo \"base_ref=$EVENT_BASE_REF\" >> \"$GITHUB_OUTPUT\"\n          else\n            echo \"head=$(gh pr view \"$PR_NUM\" --json headRefOid -q .headRefOid)\"   >> \"$GITHUB_OUTPUT\"\n            echo \"base=$(gh pr view \"$PR_NUM\" --json baseRefOid -q .baseRefOid)\"   >> \"$GITHUB_OUTPUT\"\n            echo \"base_ref=$(gh pr view \"$PR_NUM\" --json baseRef -q .baseRef)\"     >> \"$GITHUB_OUTPUT\"\n          fi\n\n      - name: Checkout PR head\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ steps.refs.outputs.head }}\n          fetch-depth: 0\n\n      - name: Install\n        shell: zsh -l {0}\n        run: corepack enable && pnpm install --frozen-lockfile\n\n      - name: Needlefish review\n        shell: zsh -l {0}\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          PR_BASE_SHA: ${{ steps.refs.outputs.base }}\n          PR_HEAD_SHA: ${{ steps.refs.outputs.head }}\n        run: ./node_modules/.bin/tsx src/cli.ts --github --pr ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n",
  },
  headFiles: {
    ".github/workflows/review.yml": "name: needlefish-review\n\n# Self-review mode: this repo IS needlefish, so the PR checkout's own src/ is\n# the tool. For OTHER repos, use the generic template in README.md (which adds a\n# second checkout of frankekn/needlefish as the tool).\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch:\n    inputs:\n      pr_number:\n        description: PR number to review (manual trigger; bypasses pull_request webhook)\n        required: true\n\npermissions:\n  contents: read\n  pull-requests: write\n  checks: write\n\njobs:\n  review:\n    runs-on: self-hosted\n    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository\n    steps:\n      - name: Checkout\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ github.event.pull_request.head.sha || github.ref }}\n          fetch-depth: 0\n\n      - name: Fetch base branch\n        run: git fetch origin \"refs/heads/$BASE_REF:refs/remotes/origin/$BASE_REF\"\n        env:\n          BASE_REF: ${{ github.event.pull_request.base.ref || 'main' }}\n\n      - name: Install\n        shell: zsh -l {0}\n        run: corepack enable && pnpm install --frozen-lockfile\n\n      - name: Needlefish review\n        shell: zsh -l {0}\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}\n          PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}\n        run: ./node_modules/.bin/tsx src/cli.ts --github --pr ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "workflow_dispatch|dispatch.{0,24}(pr|ref|branch)|github\\.ref|fall.{0,12}back.{0,24}(main|ref)|wrong.{0,20}(branch|ref|pr)|empty.{0,12}diff" },
    ],
    anchorFile: ".github/workflows/review.yml",
  },
  provenance: { repo: "frankekn/needlefish", pr: 1, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/1#discussion_r3480470296", fixSha: "3f782614d7df761c880c5c743177273044f5ee20" },
};

export default spec;
