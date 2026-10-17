# Review a branch before a pull request

Use these optional templates in a repository you own. They require an installed
`needlefish` with the `--branch --json`, `verdict`, and `render` commands, and
Node 20 or later on macOS or Linux. Keep your required CI review and human
approval rules.

## Install the shared procedure

1. Copy this directory from the Needlefish checkout to
   `.needlefish/shift-left` in your target repository.
2. Review the copied files before you run them. Commit them if your team shares
   the procedure. Install Needlefish and configure its runner through your
   existing trusted setup.
3. Choose one or more integrations below. Each integration uses this procedure
   and the same `review-gate.mjs`.

## Run the canonical review procedure

1. Commit the complete change on the branch you intend to submit. Stop edits
   during the review. The gate reviews committed `merge-base..HEAD` changes.
   Uncommitted files are outside that review.
2. Fetch and choose the actual PR base ref. For a PR targeting `main`, run
   `git fetch origin`, then use `origin/main`. For a stacked PR, use its parent
   branch instead.
3. Run one review from the target repository root.

   ```sh
   node .needlefish/shift-left/review-gate.mjs origin/main
   ```

4. Continue PR delivery only when this command exits 0. Read its confirmed
   findings, residual risks, coverage, and policy-skip notice. A docs-only policy
   skip permits delivery under Needlefish policy. It does not mean a model
   reviewed the change.
5. If the command exits nonzero, stop delivery. For `changes_requested`, assess
   the confirmed findings and repair verified defects within your authorized
   task. For `needs_human`, obtain the missing evidence or human decision. For
   a command, JSON, timeout, or rendering failure, repair that failure first.
   A P3 finding alone does not require a repair. Suggested patches require
   separate validation and authorized edits.
6. After a repair or a new commit, run the relevant tests. Choose explicitly
   whether to start another review. This procedure runs once and never applies
   patches or repeats reviews until they pass. It does not use `--fix`.

The gate invokes `needlefish --repo "$PWD" --branch --base <ref> --json` once.
It writes that invocation's stdout to a private temporary file. It uses
`needlefish verdict <file>` for the installed CLI's full schema validation and
deterministic verdict check, then `needlefish render <file>` for display.
It never reads `last-review.json`. Needlefish itself can still update its normal
cache. Only an exit 0 review with a validated, matching `pass` result permits
delivery. The gate always exits 1 for `changes_requested` and `needs_human`,
even with older CLIs whose complete non-pass commands exit 0. For a fully
validated non-pass result, each CLI command may exit 0 or 1. For `pass`, all
three commands must exit 0. Other nonzero codes block delivery.

The whole gate has a 20-minute deadline and an 8,000,000-byte output limit.
The limit counts the combined raw stdout and stderr bytes from review, verdict,
and render. Each child has closed stdin. Reading the temporary result file does
not add pipe output. The gate retains at most 16,384 characters of CLI stderr
for diagnostics, within the same byte budget. To choose another deadline, set
`NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS` to an integer from 1 through 2,147,483,647
milliseconds. Values outside this range are rejected before review starts.
Timeout and interruption stop the gate's process group
and remove its temporary result. Runner resources created outside that process
group remain the runner's responsibility. Review output contains repository
content. Handle it under your repository's disclosure policy.

## Install the Claude Code skill

Copy `claude/pre-pr-review/SKILL.md` to
`.claude/skills/pre-pr-review/SKILL.md` in the target repository. Keep the shared
procedure at `.needlefish/shift-left/README.md`. Invoke `/pre-pr-review` before
PR delivery. To remove the integration, remove only the skill file you installed.

## Install the Codex instruction

Append the contents of `codex-agents.md` to your target repository's `AGENTS.md`.
Preserve its existing instructions. To remove the integration, delete only the
section you added. This instruction controls the coding agent's pre-PR process.
It does not replace Needlefish's isolation, credentials, or review-policy rules.

## Install the Git pre-push hook

The `pre-push` template reviews only the checked-out HEAD. It blocks tag pushes,
branch deletions, and pushes of another commit. The hook binds the review to the pushed commit. It reviews the whole branch
against `origin/main`. Change the final base ref for another default branch or
for a stacked PR. It runs the canonical procedure once per push, even when
several pushed branch refs point to HEAD.

Find the active hooks directory with `git config --get core.hooksPath`, or use
`git rev-parse --git-path hooks` when that setting is absent. Resolve relative
paths from the working-tree root. If `pre-push` already exists there, preserve
it. Integrate this template into the existing hook using your hook manager or
an explicit chain that supplies the original push arguments and a fresh copy
of stdin to each hook. Both hooks must succeed. Do not overwrite an existing
hook or append this after an earlier unconditional `exit 0`.

If there is no existing `pre-push`, copy this template to that hooks directory
as `pre-push` and run `chmod +x` on it. Keep the shared files at
`.needlefish/shift-left`. To undo that installation, remove only the copied hook
and the shared files you added. With an existing hook manager, remove only this
integration and retain its other hooks. A local hook can be bypassed with Git
options and is not a substitute for a required remote check.

## Check the templates without a model

From the Needlefish checkout, run `node --test scripts/shift-left.test.mjs`.
The test uses an owned fake CLI for review output and the real CLI's read-only
`verdict` and `render` commands. It never invokes a model or reads a prior cache.
