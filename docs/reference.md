# CLI and GitHub reference

[Start with the README](../README.md). This reference contains CLI modes, result JSON, GitHub installation, runner configuration, and development setup.

## Usage

Local mode is read-only: Markdown to stdout, no GitHub writes.

Run published v0.4.10 from the repository root, and pass a root path to `--repo`.
The unreleased source resolves subdirectory invocations to Git's work-tree top
level for paths, root `AGENTS.md`, and cache placement.

**Committed work** — run from inside the target repo, or point `--repo` at it
from anywhere. The default range is merge-base…`HEAD` (see
[base detection](#base-detection)):

```bash
needlefish --repo /path/to/some-repo
needlefish --repo /path/to/some-repo --focus security
needlefish --repo /path/to/some-repo --deep
needlefish --repo /path/to/some-repo --base develop
needlefish --repo /path/to/some-repo --branch  # force merge-base..HEAD review
```

**Uncommitted work** — if the working tree is dirty, or the repo has no
commits yet, `needlefish` reviews your uncommitted changes, untracked files
included. Not a git repo yet? Run `git init` first.

```bash
needlefish --repo /path/to/some-repo --uncommitted  # force working-tree review
```

**Pull requests:**

```bash
needlefish --repo /path/to/some-repo --pr 123  # attach PR metadata to the local diff
needlefish pr 123 --repo /path/to/some-repo    # review the PR ref itself
```

**Runner and model selection:**

```bash
needlefish --repo /path/to/some-repo --runner claude
needlefish --repo /path/to/some-repo --runner opencode --model zai-coding-plan/glm-5.2
NEEDLEFISH_ACP_BIN=/path/to/acp-agent needlefish --repo /path/to/some-repo --runner acp
```

Output is Markdown on stdout, with the same review cached as JSON at
`~/.cache/needlefish/<repo>/last-review.json`. Pass `--json` to print the
`ReviewResult` JSON to stdout instead:

```bash
needlefish --repo . --json | jq .verdict
```

**Dry run** — collect the review bundle and print a redacted summary of what
would be sent to the model (mode, SHAs, changed files with surfaces, patch
size, fast-path and large-path answers). No runner is invoked and nothing is
cached:

```bash
needlefish --repo /path/to/some-repo --dry-run
needlefish --repo /path/to/some-repo --dry-run --json   # machine-readable summary
needlefish pr 123 --repo /path/to/some-repo --dry-run
```

`needlefish pr <n> --dry-run` may still `git fetch` the PR refs into the
repository — the same fetch a real `pr` review performs; the guarantee is no
model call and no cache write.

`--print-bundle` (only valid with `--dry-run`) prints the full bundle JSON —
this includes the whole diff and the repository's `AGENTS.md` policy text
verbatim:

```bash
needlefish --repo /path/to/some-repo --dry-run --print-bundle
```

A cached result can be re-rendered or re-checked without re-running the
review — both commands are read-only:

```bash
needlefish render ~/.cache/needlefish/<repo>/last-review.json
needlefish verdict ~/.cache/needlefish/<repo>/last-review.json
```

`render` runs the file through the same `renderMarkdown` used for stdout, PR
review bodies, and check summaries. `verdict` recomputes the verdict from the
cached findings through `deriveVerdict`, prints the stored and derived
verdicts, and exits 1 when they differ (e.g. an edited cache). Both cached
commands exit 1 for `changes_requested` or `needs_human`.

### Machine interface

`needlefish --repo <path> --json` and `needlefish pr <number> --json` print a
versioned `ReviewResult` JSON object to stdout — the same object the local
cache stores. Within a `schemaVersion`, fields are only added, never changed
or removed; breaking shape changes require a new `schemaVersion` and a
changelog entry.

| Field | Shape |
| --- | --- |
| `schemaVersion` | Literal `1`. |
| `verdict` | `pass`, `needs_human`, or `changes_requested`. |
| `reviewTarget` | Optional review target string. |
| `prNumber` | Optional PR number, present in GitHub mode and for `needlefish pr`. |
| `prBaseSha` | Optional PR base branch tip; `baseSha` is always the merge base. |
| `scopeCallouts` | Optional non-blocking callouts naming dependency/schema/workflow/config/public-api files present in the diff, derived from the changed-file list. |
| `docsOnlyFastPath` | Optional pipeline-generated flag that all model calls were skipped by docs-only policy. |
| `coverageGaps` | Optional list of `{ kind: "lfs_pointer_only", file }` entries (changed files the review sandbox could only check out as Git LFS pointer stubs, so their contents were not reviewed), followed by at most one `{ kind: "lfs_scan_incomplete" }` entry when the sandbox could not determine whether changed files are pointer stubs (Git LFS use or the pointer list could not be established). Reported by the sandbox, never by the model; does not affect the verdict. |
| `findings[]` | Finding objects with `severity`, `title`, `category`, `file`, `lineStart`, `lineEnd`, `confidence`, `whyItBreaks`, `suggestedFix`, and `validation`. |
| `findings[].consumerFile` | Optional downstream file affected by the finding. |
| `findings[].consumerLine` | Optional downstream line affected by the finding. |
| `residualRisks[]` | Residual-risk objects with `text` and `blocks`. |
| `checked[]` | Evidence strings describing what the review examined. |
| `stats` | Optional per-runner-call timing and attempt stats. |
| `totalDurationMs` | Optional total review duration in milliseconds. |

The full shape is published as a JSON Schema (draft 2020-12) at
[`schemas/review-result.v1.schema.json`](../schemas/review-result.v1.schema.json),
also shipped in the npm package at
`node_modules/needlefish/schemas/review-result.v1.schema.json`. The `v1`
matches `schemaVersion`. The schema allows unknown properties, so a validator
keeps working when a release adds a field. Two rules are not expressible in
the schema: a finding's `lineEnd` is never below its `lineStart`, and
`stats[].usage.totalTokens` is at least `inputTokens + outputTokens`.
`--dry-run --json` prints a different summary object that this schema does
not describe.

GitHub mode appends a final `needlefish-outcome {json}` line after diagnostics.
`outcome:"verdict"` carries the computed verdict; `outcome:"failure"` has
`operational:true` only for recognized runner transport failures. Provider
fallback consumes this result, never review prose. Blocking verdicts still
exit 1; skips keep the existing `needlefish-skip` line.

Same-head dedupe requires a trusted receipt and a completed verdict check.
Receipts are written after delivery. Missing checks, infrastructure failures,
terminations, and superseded checks do not let old receipts suppress recovery. A same-head skip keeps the
completed verdict's exit status. Legacy neutral `needs_human` checks trigger a
full re-review when that head is triggered again. After upgrading, manually
re-run open PRs with legacy neutral `needs_human` checks. Existing checks are
not updated automatically, and neutral checks can still satisfy branch protection.

Review commands that produce a verdict exit 0 only for `pass`.
`changes_requested`, `needs_human`, and execution failures exit 1, including
`--json` output. GitHub-mode closed, stale and untrusted-author skips exit 0
and print a `needlefish-skip` line. A closed or stale skip after a review error
exits 1, and one after a SIGINT or SIGTERM termination exits 130 or 143. A
same-head skip keeps the completed verdict's exit status. `needs_human` means
review incomplete or human confirmation required. It does not claim a code
defect. Retry the review or ask a maintainer to check the unreviewed scope.
Unless `NEEDLEFISH_NO_FAST_PATH=1` disables the fast path, docs-only changes
pass by policy with an explicit "Model review skipped
by policy" notice. No model has reviewed that change.

### Base detection

`--base` → `origin/HEAD` → `main`. Pass `--base <ref>` to override.

## Verdicts

The verdict is derived deterministically — model prose never decides
pass/fail:

- any P0 / P1 / P2 finding → `changes_requested`
- otherwise a blocking residual risk → `needs_human`
- otherwise → `pass`

P3-only findings are reported but do not block (the check stays green).

## GitHub Action

Two ways to run on every PR: the **hosted composite action** (
cold-starts each run) or the **self-hosted reusable workflow** (low latency,
on a machine you control). Both post the same result: a non-sticky `COMMENT`
review with the full rendered review body, plus the authoritative
`Needlefish` check-run as the merge gate.

| verdict              | review event        | check     |
| -------------------- | ------------------- | --------- |
| pass                 | COMMENT             | success   |
| changes_requested    | COMMENT             | failure   |
| needs_human          | COMMENT             | failure   |
| run failed           | (none)              | failure   |

To block incomplete reviews, set the existing `Needlefish` check as required
in the consumer repository. No strict flag or new service is needed. Needlefish
does not change branch protection. On upgrade, `needs_human` changes from
`neutral` to `failure`; workflows that accepted it must now retry or obtain
human confirmation. Superseded and policy-skipped checks keep their existing
neutral status.

All verdict reviews are `COMMENT`, never approval or blocking-review events:
the `GITHUB_TOKEN` bot cannot formally approve PRs, and a sticky blocking
review can outlive a fixed head. The check-run is the merge gate — a failed
review never passes a PR because the check goes `failure`. When a finding
includes a validated exact replacement, its inline comment carries a native
GitHub suggestion block; failed validation falls back to a plain comment.

Skipped reviews — a closed PR, an untrusted author, a head that moved
mid-review, or an already-reviewed head — still print a machine-readable
`needlefish-skip {"reason":"closed_pr"|"untrusted_author"|"stale_head"|"same_head","prNumber":<n>,"headSha":"<sha>"}`
line to stdout for automation, alongside the existing prose notice.

### Hosted (any repo)

The setup preview in this reference uses this repo's composite action on GitHub-hosted
`ubuntu-latest`. It needs a reviewed workflow PR and a repository secret.

**Runner auth** — repo secrets, passed via `env` on the action step:

| runner   | secret(s) |
| -------- | --------- |
| codex    | `CODEX_AUTH_JSON` (contents of a logged-in `~/.codex/auth.json`) or `CODEX_API_KEY` |
| claude   | `ANTHROPIC_API_KEY` |
| opencode | provider key for the chosen model (e.g. `OPENAI_API_KEY`) |
| pi       | `PI_AUTH_JSON` (contents of a logged-in `~/.pi/agent/auth.json`) |

The hosted install step only accepts `codex`, `claude`, `opencode`, or `pi`.
`grok` and `acp` are CLI runners and `openai` is HTTP — the hosted action
installs none of them, and passing `runner: grok` (or `openai` / `acp`) fails
that install step; use the self-hosted workflow below for these CLI runners. Claude's
auth vars (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`) and opencode's
`OPENAI_API_KEY` are allowlisted through to the runner subprocess; other
providers' keys need `NEEDLEFISH_RUNNER_ENV_PASSTHROUGH=VAR` (see
[subprocess environment](#subprocess-environment)).

**Inputs** (all optional): `pr_number` (defaults to the event PR), `runner`
(default `codex`), `model`, `timeout_ms`, `codex_reasoning_effort`,
`runner_version`, `repo_path` (defaults to the workspace checkout),
`github_token` (defaults to the workflow token), `allow_untrusted_author`
(default `false`).

**Runner versions:** when `runner_version` is omitted, the action installs
the latest release of the selected runner's CLI (`@openai/codex`,
`@anthropic-ai/claude-code`, `@opencode/cli`, or
`@earendil-works/pi-coding-agent`). Pass an explicit version to pin one.

**Cost and behavior:**

- Small PRs: 2 model calls (review + critic) at the workflow default,
  `gpt-5.6-terra` at `high` effort. Large PRs: 1 map call + N deep calls
  (concurrency 3 by default) + 1 critic.
- Docs-only PRs and same-head re-runs cost 0 model calls (force a re-review
  with `--recheck`).
- The hosted path cold-starts on every run (pnpm install + runner CLI
  install, roughly a minute). The self-hosted path below stays the
  low-latency option.
- The generated workflow fails before checkout for fork, bot, and untrusted
  author PRs. It does not mark them reviewed. Do not use `pull_request_target`
  with the generated workflow.
- Only PRs whose author is an OWNER, MEMBER, or COLLABORATOR and not a bot
  are reviewed. Others get a neutral `Needlefish` check instead; after
  reading the PR, a maintainer can review it with
  `allow_untrusted_author: true`. GitHub mode itself enforces this gate, so a
  custom workflow that calls `needlefish --github` directly gets it too; set
  `NEEDLEFISH_ALLOW_UNTRUSTED_AUTHOR=1` there to override.

**Comment commands:** the composite action does not add PR comment commands
to the consumer repo. This repository's `.github/workflows/commands.yml`
listens for maintainer `@needlefish recheck` and
`@needlefish explain <finding>` comments (OWNER / MEMBER / COLLABORATOR
only): recheck dispatches this repo's `review.yml`, and explain runs
`needlefish explain` on a self-hosted runner that already has
`~/.local/bin/needlefish`. Copying that file into another repo only works
after you retarget those two jobs.

### Self-hosted runner

This installation uses an operator-managed Needlefish bundle. Review workflows
never fetch upstream source, resolve an upstream `main` SHA, or deploy a release.
Each consumer vendors a `workflow_call`-only copy of the reviewed workflow at
`.github/workflows/needlefish-review-local.yml`; its existing caller owns PR and
manual triggers, so one event cannot start two reviews.

```yaml
jobs:
  review:
    uses: ./.github/workflows/needlefish-review-local.yml
    with:
      pr_number: ${{ inputs.pr_number || github.event.pull_request.number }}
      runner: codex
      model: gpt-5.6-terra
      codex_reasoning_effort: xhigh
    secrets: inherit
```

The caller must retain `workflow_dispatch.inputs.pr_number`, `actions: write`,
and a run name ending in ` PR #<number>` for bounded reconciliation. Reconcile
runs on GitHub-hosted Ubuntu independently of the review runner.
Set the repository variable `NEEDLEFISH_RUNS_ON` to an operator-owned runner
label when direct PR triggers should use a dedicated fleet; otherwise the
workflow keeps the `self-hosted` default. Explicit `runs_on` inputs still win.

Provision the tested self-managed bundle as the runner service account under
`~/.local/share/needlefish-self/releases/<self_version>`. Keep `release.json`,
`self-managed.patch`, and the frozen `pnpm-lock.yaml` with the bundle; point the
operator-owned `needlefish-self/current` link at that version. Each review resolves
that link once, validates its metadata and patch/lockfile digests, and runs only
the selected immutable binary. A missing or invalid installation fails closed.
The manual `needlefish-deploy` workflow only checks the installed version; source
pushes and upstream releases cannot replace it.

Keep the current Codex CLI available as the same service account. The review lane is
`gpt-5.6-terra / xhigh / fast`. The bundle includes the proxy tier forwarding fix:
fast is passed to Codex even with a custom provider. Provider acceptance and the
service tier actually delivered still require provider evidence.


```bash
npm install --global --prefix "$HOME/.local" @openai/codex@latest
export CODEX_BIN="$HOME/.local/bin/codex"
"$CODEX_BIN" --version
```

Preserve each caller's existing authentication route. Proxy callers pass
`codex_proxy_base_url`, `codex_proxy_required: true`, and `codex_proxy_api_key`;
this repository's direct trigger may use the `CODEX_PROXY_BASE_URL` repository
variable. Required proxy mode fails on missing credentials rather than falling
back to OAuth. Credentials remain in the child environment. Fork/closed/stale-PR
checks, checkout credential isolation, and hosted finalization remain enforced.
Model CLIs run unrestricted on these runners, so PRs from untrusted or bot
authors are skipped with a neutral check; dispatch `review.yml` manually with
`allow_untrusted_author: true` to review one after reading it. Reconciliation
never sets that input. The installed binary enforces the same gate in GitHub
mode; `NEEDLEFISH_ALLOW_UNTRUSTED_AUTHOR=1` is its override.

## Runners

`--runner` / `NEEDLEFISH_RUNNER` accepts `codex`, `claude`, `opencode`,
`openai`, `grok`, `pi`, or `acp`; `src/shared/codex.ts` invokes the selected
runner. Common options:

| option | env | default |
| --- | --- | --- |
| runner | `NEEDLEFISH_RUNNER` | auto-detects `codex`, then `claude`, then `opencode` |
| model | `NEEDLEFISH_MODEL` | runner default |
| Codex reasoning effort | `CODEX_REASONING_EFFORT` | `medium` (composite action and reusable workflow: `high` for `gpt-5.6-terra`) |
| per-attempt timeout | `NEEDLEFISH_TIMEOUT_MS` | `1200000` (20 min) |
| shared review deadline | `NEEDLEFISH_REVIEW_TIMEOUT_MS` | unset |
| single attempt per call | `NEEDLEFISH_NO_RETRY` | unset (`1` = on) |
| termination grace | `NEEDLEFISH_TERMINATION_GRACE_MS` | `5000` |
| opencode idle timeout | `OPENCODE_IDLE_TIMEOUT_MS` | the smaller of the per-call timeout and `600000` |

`NEEDLEFISH_REVIEW_TIMEOUT_MS` sets one monotonic deadline for the model pipeline.
Every map/review, deep, critic, JSON repair and process retry shares it; each
runner attempt is capped by the smaller of its per-attempt timeout and remaining
time. Retry backoff must fit before another attempt can start. Expiry fails
closed and never converts incomplete coverage into a pass. Leave this below the
outer job/shell timeout to allow process teardown and report delivery; those
operations are not replaced by this model-execution deadline. Unset preserves
the existing per-attempt behavior.

`NEEDLEFISH_NO_RETRY=1` gives every runner call one attempt: a crash, non-zero
exit, or idle stall fails that pass instead of running once more after the
retry backoff. Use it on high-volume lanes that prefer a predictable completion
time over retry recovery; the review deadline still bounds the run either way.

On SIGINT or SIGTERM (a job timeout, cancellation, or watchdog) Needlefish
forwards the received signal to the runner process group, SIGKILLs it once
`NEEDLEFISH_TERMINATION_GRACE_MS` has elapsed, and exits 130 or 143; a second
signal exits at once. In GitHub mode
it first completes its own in_progress `Needlefish` check inside that same
grace: `failure` titled `Needlefish: review terminated` on the current head,
or neutral `Needlefish: superseded` when the head moved or the PR closed.
No review or comment is posted, and the completion's GitHub calls are cut off
at the grace so a hung `gh` cannot hold the process. Keep the grace below the
caller's forced kill: GitHub Actions sends SIGINT, SIGTERM 7.5 s later, then
kills 2.5 s after that.

The opencode idle deadline resets whenever the CLI emits stdout or stderr. If
a provider stream stops producing output, Needlefish terminates that attempt
and uses the normal runner retry instead of waiting for an extended per-call
timeout. An attempt that runs out its whole per-attempt timeout is not retried:
a second attempt would wait out the same stuck upstream and double the pass.

When neither `--runner` nor `NEEDLEFISH_RUNNER` is set and none of `codex`,
`claude`, or `opencode` can be found, Needlefish exits with install commands
for those three CLIs instead of a stack trace. Auto-detect does not look for
`grok`, `pi`, `openai`, or `acp`.

The `openai` HTTP runner has no repository-reading tools. All model review
paths, including the small-diff critic, require those tools. The unreleased
source rejects every HTTP model review before any request. Published v0.4.10
does not guarantee that refusal. Use a recommended CLI runner, such as
`codex`, `claude`, or `opencode`. Docs-only skips remain supported.
`--dry-run` applies the same capability check, and `doctor` reports the same
restriction.

ACP launcher repository capability is `unknown`. A successful protocol
initialize does not prove tool access. ACP execution remains experimental;
`doctor` and `--dry-run` report that limitation without certifying the launcher.

Per-runner env vars. For CLI runners, binary / model / listed auth vars are
in that runner's subprocess allowlist. The `openai` runner is HTTP and reads
its env in-process (its subprocess allowlist is empty). Defaults in
parentheses are the executable names used when the `*_BIN` var is unset or
blank (values are trimmed):

| runner | binary | model / other |
| --- | --- | --- |
| `codex` | `CODEX_BIN` (`codex`) | `CODEX_MODEL`, `CODEX_TIMEOUT_MS`, `CODEX_RETRY_MS`, `CODEX_REASONING_EFFORT`; proxy `CODEX_PROXY_BASE_URL`, `CODEX_PROXY_API_KEY`, `NEEDLEFISH_CODEX_PROXY_REQUIRED=1` |
| `claude` | `CLAUDE_BIN` (`claude`) | `CLAUDE_MODEL`; auth `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` |
| `opencode` | `OPENCODE_BIN` (`opencode`) | `OPENCODE_MODEL`; auth `OPENAI_API_KEY` |
| `grok` | `GROK_BIN` (`grok`) | `GROK_MODEL` |
| `pi` | `PI_BIN` (`pi`) | `PI_MODEL`, `PI_PROVIDER` (default `openai-codex`), `PI_AUTH_MODE` (`oauth` or `proxy`; defaults to OAuth for `openai-codex`, proxy for an explicit provider) |
| `acp` | `NEEDLEFISH_ACP_BIN` (required) | — |
| `openai` | none (HTTP, not a CLI) | `OPENAI_API_KEY` (required), `--model` / `OPENAI_MODEL` (required), `OPENAI_BASE_URL` (default `https://api.openai.com/v1`) |

### How each runner is launched

- **Codex:** `--ignore-user-config --ignore-rules
  --dangerously-bypass-approvals-and-sandbox`, so its inspection commands are
  not blocked by execpolicy rules, approval prompts, or the host sandbox.
  Reasoning effort defaults to `medium`; set `CODEX_REASONING_EFFORT=high` to
  restore the old default, or `xhigh` for the highest-effort mode.
- **Claude Code:** `--dangerously-skip-permissions`, `--safe-mode`, and
  `--no-session-persistence`.
- **Grok:** `--always-approve --permission-mode bypassPermissions --no-plan
  --sandbox off`.
- **opencode:** `--auto` in headless mode, with an inline `permission:
  "allow"` override for its global and build-agent permissions.
- **pi:** `--no-session --mode text --provider openai-codex --thinking
  <level>` and its default full toolset.
- **ACP:** a JSON-RPC 2.0 Agent Client Protocol process over stdio from
  `NEEDLEFISH_ACP_BIN`. On timeout Needlefish sends `session/cancel`, then
  applies the same process-group kill path as the CLI runners. When the prompt
  response includes token usage, review stats retain its input/output totals.

Every CLI runner executes inside a **throwaway clean clone** at the review
head commit, with GitHub tokens stripped and the expected `HEAD` fixed. After
each successful model call, Needlefish re-checks the clone with `git status
--porcelain --untracked-files=all --ignored=matching`, verifies `HEAD` did
not move, and rejects any worktree mutation. The clone carries no remote: its
`origin` (which would point at the original repository on the same
filesystem) is removed before the runner starts, so an ordinary `git push`
from inside the sandbox cannot create, force-update, or delete branches in
the original. This closes the ready-made push route only; it is not an
OS-level boundary, and a runner that learns the original path can still write
there directly. Closed PRs are skipped before diffing or model invocation.

Uncommitted clones expose `WORKING` as the synthetic review commit and, for an
unborn source, `EMPTY` as an empty baseline commit. Result JSON retains these
labels; both are executable Git refs inside the disposable clone.

### Subprocess environment

Runner CLIs (`codex`, `claude`, `opencode`, `grok`, `pi`, `acp`) are spawned
with an allowlisted environment, not the full parent `process.env` — only
locale/proxy/path basics plus each runner's own `_BIN`/`_MODEL`-style
variables are passed through. To pass an additional variable to the runner
subprocess, set `NEEDLEFISH_RUNNER_ENV_PASSTHROUGH=VAR1,VAR2` (comma-separated
names). On GitHub Actions, the non-secret `RUNNER_TRACKING_ID` job marker is
retained so the self-hosted runner can terminate detached model processes
when a job is cancelled.

ACP env authentication additionally requires an explicit credential
declaration: set `NEEDLEFISH_ACP_AUTH_ENV_VARS` to the credential names and
include those same names in `NEEDLEFISH_RUNNER_ENV_PASSTHROUGH` — for example
`NEEDLEFISH_ACP_AUTH_ENV_VARS=MY_AGENT_TOKEN` with
`NEEDLEFISH_RUNNER_ENV_PASSTHROUGH=MY_AGENT_TOKEN`. Arbitrary passthrough
configuration does not prove authentication. Alternatively, set
`NEEDLEFISH_ACP_AUTH_FILES` to comma-separated HOME-relative credential
files; Needlefish copies only those files into the disposable runner HOME.

## Development

Requires Node 20+, Corepack (recommended) or the pinned pnpm from
`packageManager`, one supported model CLI authed locally (Codex, Claude Code,
or opencode), and the GitHub CLI (`gh`) for `--pr`, `pr`, and GitHub Action
mode.

```bash
git clone https://github.com/frankekn/needlefish
cd needlefish
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
corepack enable
corepack prepare "$PNPM_VERSION" --activate
pnpm install --frozen-lockfile
```

If Corepack is unavailable, install the pinned package manager directly:

```bash
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
npm exec --yes --package "$PNPM_VERSION" -- pnpm install --frozen-lockfile
```

**Dev shim on PATH (optional):** the repo keeps a `bin/needlefish`
development shim. Symlink it onto a PATH directory so you can invoke
`needlefish` from any cwd:

```bash
ln -sf "$PWD/bin/needlefish" ~/.local/bin/needlefish   # or any PATH dir
needlefish --version
```

The shim resolves symlinks and runs the repo-local `tsx` against
`src/cli.ts`, so it survives the repo being linked from elsewhere and works
in non-interactive shells (unlike a shell alias). Without this step, invoke
via the full path:
`/path/to/needlefish/node_modules/.bin/tsx /path/to/needlefish/src/cli.ts`
(cwd is the target).

## Status

v0.4.10. Read-only. Shipped: inline review comments, sticky re-review
(fresh/open/no longer reported across pushes), docs-only fast path (no model calls),
same-head dedupe, hosted-runner repo inspection (best-effort AppArmor
sysctl), local `--dry-run` bundle preview, machine-readable skip reasons,
non-blocking scope callouts, and cached-result `render` / `verdict`
diagnostics. `--fix` stays unimplemented by design. Maintainer `@needlefish
recheck` / `@needlefish explain` comments exist in this repository's
`.github/workflows/commands.yml`; the published composite action does not
install that workflow.

## Doctor and GitHub setup details

`npx needlefish doctor` checks Node, the
selected runner CLI and its version, whether that CLI reports itself logged
in (via its own status command, under the same environment allowlist a review
uses; an env credential the review accepts, such as `OPENAI_API_KEY` for
opencode, passes without probing), the git repo, and the detected base ref,
in seconds and with no model call. Every failed check prints its fix; `--json` gives the same report to
scripts and agents. The exit code is 1 when any check fails and 0 otherwise;
a check the doctor cannot decide (a runner CLI with no status command) is
reported as `unknown` and does not fail the exit code.

Preview the hosted workflow from this source checkout:

```bash
pnpm review setup github --repo /path/to/repo
```

After this version is published to npm, use
`npx needlefish setup github --repo /path/to/repo` for the same preview.

The command shows the proposed `.github/workflows/needlefish.yml` or a diff
against its own existing file. It writes nothing and refuses to replace a
custom Needlefish workflow. The proposed workflow uses a pinned action and
Codex CLI, and fails before checkout for fork, bot, or untrusted-author PRs.
It is a preview, not an enabled installation. A repository administrator
must add the workflow through a reviewed PR and set the Actions secret
`NEEDLEFISH_CODEX_API_KEY` separately. No credential, setup PR, or review is
created by this command. It does not configure a required check or branch
protection. Once enabled, findings arrive as
inline review comments anchored to the diff; pushes update the same review in
place (fresh / still-open / no longer reported) instead of stacking new ones.

## Historical benchmark notes

The commentary below records historical experiments. It does not select the current production lane. Read each linked report for its source and date.

Which model, agent harness, provider route, and effort catches real PR
defects without blocking clean changes? The README tables are generated from
the same guarded report JSON as the benchmark page (`eval/gen-readme.ts`);
the curated chronology and confirmation re-runs live in
[eval/RESULTS.md](https://github.com/frankekn/needlefish/blob/main/eval/RESULTS.md).
The [benchmark page](https://frankekn.github.io/needlefish/) generates
its leaderboard from the same guarded reports and is never hand-edited.

**Reading the columns:** **Balanced** is the primary score — the arithmetic
mean of anchored recall and usable specificity. **Tier-1** is recall on
must-find defects and a hard qualification gate. **FP** is clean PRs blocked.
**Noise/review** is extra findings per positive review (gate at 0.12). Rows
compare only when prompt, fixture-set, and scorer hashes and the anti-cheat
version all match; provider failures and unavailable subscription models are
operational outcomes, not zero model scores. A review that runs out its
per-call deadline is scored as a failed review, because that is what the PR
author gets.

[Generated leaderboard](../README.md#benchmarks)

**Latest ranked result, 2026-10-13:** Muse Code 1.4.7 ran `muse-wonder-1.0`
at `high` on the benchmark's frozen pipeline, all 87 fixtures × 3 draws.
Balanced score 90.47%, recall 93.44%, Tier-1 100%, FP 12.50%, invalid 0%,
positive noise 0.060, and mean 35.8s. It qualifies as a Candidate in the tied
rank-7 group. Higher recall than Terra high comes with more clean-fixture
false positives, not a demonstrated statistical win. The run used 510 native
Muse CLI calls. ACP is the bridge protocol, not the displayed harness.
The original report is preserved beside the post-run public environment
attestation. Historical x1 and quota reports remain separate unranked evidence.
See the [ranked x3 report](../eval/RESULTS.md#2026-10-13-muse-code-wonder-10-high-ranked-x3).
Publication adds no Muse calls and does not change the deployed lane.

Reading: Grok 4.6 leads on accuracy and noise but is 3.7× slower per review
and needs the Grok CLI authenticated on the runner, so it stays a candidate.
Terra high and Sol are statistically unresolved against each other; Terra
high is faster and cleaner on clean fixtures.

**Deployed-lane change, Terra xhigh → Terra high** — same model,
subscription, harness, and run. Bold marks the better value in each row.

| | xhigh (before) | high (now) | Δ |
| --- | ---: | ---: | ---: |
| Balanced | **90.39%** | 89.95% | −0.4 pt |
| Tier-1 recall | 90.48% | **100%** | +9.5 pt |
| Anchored recall | 86.34% | **89.62%** | +3.3 pt |
| Tier-3 recall | 72.22% | **77.78%** | +5.6 pt |
| Usable specificity | **94.44%** | 90.28% | −4.2 pt |
| False positives (of 72 clean draws) | **4.17% (3)** | 9.72% (7) | +4 draws |
| Positive noise / review | 0.1202 | **0.0765** | −0.0437 |
| Invalid output | 0.38% | **0%** | −1 draw |
| Mean review time | 80s | **63s** | −21% |

Reading: the switch buys Tier-1 completeness, recall, and speed at the cost
of four more blocked clean draws. Sol medium was the alternative at rank 2;
it has higher recall but nearly double the false-positive rate of Terra high.

The full methodology, per-fixture matrices, and chronological experiment
record live in
[eval/RESULTS.md](https://github.com/frankekn/needlefish/blob/main/eval/RESULTS.md)
and
[RESULTS_HISTORY.md](https://github.com/frankekn/needlefish/blob/main/eval/RESULTS_HISTORY.md);
raw reports under
[eval/results/](https://github.com/frankekn/needlefish/tree/main/eval/results).
