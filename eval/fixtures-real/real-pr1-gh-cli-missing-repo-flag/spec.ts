// Real-PR fixture (curated from review-thread evidence, NOT the code diff).
// mustFind patterns below were derived from the reviewer's own wording in the
// linked PR thread per eval/fixtures-real/README.md step 4 -- never from
// reverse-engineering the diff. Patterns commander-reviewed 2026-07-10.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr1-gh-cli-missing-repo-flag",
  kind: "positive",
  tier: 2,
  defectClass: "gh-cli-missing-repo-flag-before-checkout",
  description:
    "Real PR (rejected in review): the workflow_dispatch 'Resolve PR refs' step calls gh pr view before actions/checkout has run, so there is no local git repo for gh to infer the target repository from, and the call can fail without an explicit -R/--repo. Source: https://github.com/frankekn/needlefish/pull/1#discussion_r3481125209.",
  baseFiles: {
    ".github/workflows/review.yml": "name: needlefish-review\n\n# Self-review mode: this repo IS needlefish, so the PR checkout's own src/ is\n# the tool. For OTHER repos, use the generic template in README.md (which adds a\n# second checkout of frankekn/needlefish as the tool).\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch:\n    inputs:\n      pr_number:\n        description: PR number to review (manual trigger; bypasses pull_request webhook)\n        required: true\n\npermissions:\n  contents: read\n  pull-requests: write\n  checks: write\n\njobs:\n  review:\n    runs-on: self-hosted\n    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository\n    steps:\n      - name: Resolve PR refs\n        id: refs\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          REPO: ${{ github.repository }}\n          PR_NUM: ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n          EVENT_HEAD: ${{ github.event.pull_request.head.sha }}\n          EVENT_BASE: ${{ github.event.pull_request.base.sha }}\n        run: |\n          if [ -n \"$EVENT_HEAD\" ]; then\n            echo \"head=$EVENT_HEAD\" >> \"$GITHUB_OUTPUT\"\n            echo \"base=$EVENT_BASE\" >> \"$GITHUB_OUTPUT\"\n          else\n            echo \"head=$(gh pr view \"$PR_NUM\" -R \"$REPO\" --json headRefOid -q .headRefOid)\" >> \"$GITHUB_OUTPUT\"\n            echo \"base=$(gh pr view \"$PR_NUM\" -R \"$REPO\" --json baseRefOid -q .baseRefOid)\" >> \"$GITHUB_OUTPUT\"\n          fi\n\n      - name: Checkout PR head\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ steps.refs.outputs.head }}\n          fetch-depth: 0\n\n      - name: Install\n        shell: zsh -l {0}\n        run: corepack enable && pnpm install --frozen-lockfile\n\n      - name: Needlefish review\n        shell: zsh -l {0}\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          PR_BASE_SHA: ${{ steps.refs.outputs.base }}\n          PR_HEAD_SHA: ${{ steps.refs.outputs.head }}\n        run: ./node_modules/.bin/tsx src/cli.ts --github --pr ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n",
  },
  headFiles: {
    ".github/workflows/review.yml": "name: needlefish-review\n\n# Self-review mode: this repo IS needlefish, so the PR checkout's own src/ is\n# the tool. For OTHER repos, use the generic template in README.md (which adds a\n# second checkout of frankekn/needlefish as the tool).\n\non:\n  pull_request:\n    types: [opened, synchronize, reopened]\n  workflow_dispatch:\n    inputs:\n      pr_number:\n        description: PR number to review (manual trigger; bypasses pull_request webhook)\n        required: true\n\npermissions:\n  contents: read\n  pull-requests: write\n  checks: write\n\njobs:\n  review:\n    runs-on: self-hosted\n    if: github.event_name == 'workflow_dispatch' || github.event.pull_request.head.repo.full_name == github.repository\n    steps:\n      - name: Resolve PR refs\n        id: refs\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          PR_NUM: ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n          EVENT_HEAD: ${{ github.event.pull_request.head.sha }}\n          EVENT_BASE: ${{ github.event.pull_request.base.sha }}\n        run: |\n          if [ -n \"$EVENT_HEAD\" ]; then\n            echo \"head=$EVENT_HEAD\" >> \"$GITHUB_OUTPUT\"\n            echo \"base=$EVENT_BASE\" >> \"$GITHUB_OUTPUT\"\n          else\n            echo \"head=$(gh pr view \"$PR_NUM\" --json headRefOid -q .headRefOid)\" >> \"$GITHUB_OUTPUT\"\n            echo \"base=$(gh pr view \"$PR_NUM\" --json baseRefOid -q .baseRefOid)\" >> \"$GITHUB_OUTPUT\"\n          fi\n\n      - name: Checkout PR head\n        uses: actions/checkout@v4\n        with:\n          ref: ${{ steps.refs.outputs.head }}\n          fetch-depth: 0\n\n      - name: Install\n        shell: zsh -l {0}\n        run: corepack enable && pnpm install --frozen-lockfile\n\n      - name: Needlefish review\n        shell: zsh -l {0}\n        env:\n          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n          PR_BASE_SHA: ${{ steps.refs.outputs.base }}\n          PR_HEAD_SHA: ${{ steps.refs.outputs.head }}\n        run: ./node_modules/.bin/tsx src/cli.ts --github --pr ${{ github.event.inputs.pr_number || github.event.pull_request.number }}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "gh pr view|-R\\b|--repo\\b|GH_REPO|infer.{0,20}repo|before.{0,20}checkout|no.{0,12}(local.{0,12})?(git.{0,12})?repo" },
    ],
    anchorFile: ".github/workflows/review.yml",
  },
  provenance: { repo: "frankekn/needlefish", pr: 1, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/1#discussion_r3481125209", fixSha: "fd23bb50d8063d0aa9796f6a15dcd226ce4c2f00" },
};

export default spec;
