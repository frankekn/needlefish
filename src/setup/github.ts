import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WORKFLOW = ".github/workflows/needlefish.yml";
const MARKER = "# needlefish-setup-template: 1";
export const GITHUB_SETUP_BRANCH = "needlefish/setup-v1";
const SETUP_BRANCH_GUARD = `          if [ "$HEAD_BRANCH" = "${GITHUB_SETUP_BRANCH}" ]; then
            echo "::error::Needlefish has not reviewed this setup PR. This branch is reserved for configuration only; inspect and merge setup before authorizing a separate review."
            exit 1
          fi
`;

export const GITHUB_WORKFLOW = `${MARKER}
name: Needlefish review
on:
  pull_request:
    types: [opened, reopened, synchronize, ready_for_review]
permissions:
  contents: read
  pull-requests: write
  checks: write
concurrency:
  group: needlefish-\${{ github.repository }}-\${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 35
    steps:
      - name: Require a trusted same-repository PR
        env:
          TARGET_REPO: \${{ github.repository }}
          HEAD_REPO: \${{ github.event.pull_request.head.repo.full_name }}
          HEAD_BRANCH: \${{ github.head_ref }}
          AUTHOR_ASSOCIATION: \${{ github.event.pull_request.author_association }}
          AUTHOR_TYPE: \${{ github.event.pull_request.user.type }}
        run: |
${SETUP_BRANCH_GUARD}          if [ "$HEAD_REPO" != "$TARGET_REPO" ] || [ "$AUTHOR_TYPE" = Bot ]; then
            echo "::error::Needlefish has not reviewed this PR. A maintainer must review fork or bot PRs."
            exit 1
          fi
          case "$AUTHOR_ASSOCIATION" in
            OWNER|MEMBER|COLLABORATOR) ;;
            *) echo "::error::Needlefish has not reviewed this PR. A maintainer must review this author."; exit 1 ;;
          esac
      - name: Require Codex credential
        env:
          CODEX_API_KEY: \${{ secrets.NEEDLEFISH_CODEX_API_KEY }}
        run: |
          if [ -z "$CODEX_API_KEY" ]; then
            echo "::error::Set repository secret NEEDLEFISH_CODEX_API_KEY before review."
            exit 1
          fi
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          ref: \${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: frankekn/needlefish@7e5c4738eeac71c87be1766b3bb30fb82fc4706f
        with:
          runner: codex
          runner_version: 0.163.0
          model: gpt-5.6-terra
          codex_reasoning_effort: high
        env:
          CODEX_API_KEY: \${{ secrets.NEEDLEFISH_CODEX_API_KEY }}
          NEEDLEFISH_REVIEW_TIMEOUT_MS: "1800000"
`;

export const PREVIOUS_GITHUB_WORKFLOW = GITHUB_WORKFLOW
  .replace("          HEAD_BRANCH: ${{ github.head_ref }}\n", "")
  .replace(SETUP_BRANCH_GUARD, "");

export type GithubSetupPlan =
  | { readonly kind: "create"; readonly path: string; readonly proposed: string }
  | { readonly kind: "unchanged"; readonly path: string; readonly proposed: string }
  | { readonly kind: "update"; readonly path: string; readonly proposed: string; readonly current: string }
  | { readonly kind: "conflict"; readonly path: string; readonly proposed: string; readonly reason: string };

function isOwnedWorkflow(content: string): boolean {
  return content.startsWith(`${MARKER}\n`) && /uses:\s*frankekn\/needlefish@/.test(content);
}

export function planGithubSetup(repo: string): GithubSetupPlan {
  let root: string;
  try {
    root = execFileSync("git", ["-C", repo, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).replace(/\n$/, "");
  } catch {
    throw new Error(`${repo} is not a Git repository`);
  }

  const path = join(root, WORKFLOW);
  const github = join(root, ".github");
  const workflows = join(root, ".github", "workflows");
  const githubStat = lstatSync(github, { throwIfNoEntry: false });
  if (githubStat && !githubStat.isDirectory()) {
    return { kind: "conflict", path, proposed: GITHUB_WORKFLOW, reason: `${github} is not a directory` };
  }
  const workflowsStat = lstatSync(workflows, { throwIfNoEntry: false });
  if (workflowsStat && !workflowsStat.isDirectory()) {
    return { kind: "conflict", path, proposed: GITHUB_WORKFLOW, reason: `${workflows} is not a directory` };
  }
  if (workflowsStat) {
    for (const entry of readdirSync(workflows, { withFileTypes: true })) {
      if (entry.name === "needlefish.yml" || !entry.isFile() || !/\.ya?ml$/.test(entry.name)) continue;
      const existing = join(workflows, entry.name);
      const content = readFileSync(existing, "utf8").replace(/^\s*#.*$/gm, "");
      if (/frankekn\/needlefish(?:@|\/)/i.test(content) || (/needlefish/i.test(content) && /--github/.test(content))) {
        return { kind: "conflict", path, proposed: GITHUB_WORKFLOW, reason: `${existing} already configures Needlefish` };
      }
    }
  }
  const pathStat = lstatSync(path, { throwIfNoEntry: false });
  if (pathStat) {
    if (!pathStat.isFile()) {
      return { kind: "conflict", path, proposed: GITHUB_WORKFLOW, reason: `${path} is not a regular file` };
    }
    const current = readFileSync(path, "utf8");
    if (!isOwnedWorkflow(current)) {
      return { kind: "conflict", path, proposed: GITHUB_WORKFLOW, reason: `${path} is not managed by Needlefish setup` };
    }
    if (current === GITHUB_WORKFLOW) return { kind: "unchanged", path, proposed: GITHUB_WORKFLOW };
    return { kind: "update", path, current, proposed: GITHUB_WORKFLOW };
  }
  return { kind: "create", path, proposed: GITHUB_WORKFLOW };
}

export function renderGithubSetup(plan: GithubSetupPlan): string {
  const lines = [
    `Workflow: ${plan.path}`,
    `Plan: ${plan.kind}`,
    "Trigger: pull_request opened, reopened, synchronize, ready_for_review.",
    "Scope: trusted same-repository PRs. Forks, bots, and untrusted authors fail without review.",
    "Secret: NEEDLEFISH_CODEX_API_KEY (repository Actions secret).",
    "Code destination: OpenAI Codex. Model calls may incur charges; the amount depends on usage and account pricing.",
    "Required-check policy is not configured by this preview. Confirm branch protection separately.",
    "This is a preview only. No credential was configured, no PR was created, and no review was completed.",
  ];
  if (plan.kind === "conflict") return `${lines.join("\n")}\nConflict: ${plan.reason}\n`;
  if (plan.kind === "unchanged") return `${lines.join("\n")}\nThe managed workflow already matches this template.\n`;
  if (plan.kind === "create") return `${lines.join("\n")}\nProposed workflow:\n${plan.proposed}`;
  const diff = spawnSync("git", ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", plan.path, "-"], { input: plan.proposed, encoding: "utf8" });
  if (diff.error || diff.status !== 1) throw new Error(`could not preview workflow diff: ${diff.error?.message ?? diff.stderr}`);
  return `${lines.join("\n")}\nProposed changes:\n${diff.stdout}`;
}
