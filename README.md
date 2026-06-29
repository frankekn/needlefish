<p align="center">
  <img src="assets/banner.png" alt="Needlefish" width="100%">
</p>

# needlefish

Strict local PR review agent. Acts like a senior engineer reviewing your diff
before merge — only real defects (bugs, regressions, security, data loss,
migration/upgrade risk, missing validation, duplicate behavior), never style.

Read-only by default. Two model calls per review: a deep pass, then an
adversarial critic that prunes weak findings. Codex is the default runner;
Claude Code and opencode are also supported. Verdict is derived
deterministically from the surviving findings, never freehanded by the model.

## Install

Requires:

- Node 20+
- Corepack (recommended) or the pinned pnpm from `packageManager`
- One supported model CLI authed locally: Codex (default), Claude Code, or opencode
- GitHub CLI (`gh`) for `--pr` / GitHub Action mode

```bash
git clone https://github.com/frankekn/needlefish
cd needlefish
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
corepack enable
corepack prepare "$PNPM_VERSION" --activate
pnpm install --frozen-lockfile
```

If Corepack is unavailable, install the package manager pinned in
`package.json`:

```bash
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
npm exec --yes --package "$PNPM_VERSION" -- pnpm install --frozen-lockfile
```

### Make `needlefish` resolve on PATH (optional, recommended)

The package ships a `bin/needlefish` shim (declared in `package.json`). After
clone, symlink it onto a directory that's on your PATH so you can invoke
`needlefish` from any cwd/shell:

```bash
ln -sf "$PWD/bin/needlefish" ~/.local/bin/needlefish   # or any PATH dir
needlefish --version
```

The shim resolves symlinks and runs the repo-local `tsx` against `src/cli.ts`,
so it survives the repo being linked from elsewhere and works in non-interactive
shells (unlike a shell alias). Without this step, invoke via the full path below.

## Local use (read-only, no GitHub writes)

Run from inside any repo you want reviewed, on a branch with changes:

```bash
# If the bin is linked (above), from inside the target repo:
cd /path/to/some-repo
needlefish

# Otherwise, full path (cwd is the target):
/path/to/needlefish/node_modules/.bin/tsx /path/to/needlefish/src/cli.ts

# Point at the target with --repo from anywhere:
needlefish --repo /path/to/some-repo --focus security
needlefish --repo /path/to/some-repo --deep
needlefish --repo /path/to/some-repo --pr 123  # pulls PR metadata via gh
needlefish --repo /path/to/some-repo --base develop
needlefish --repo /path/to/some-repo --runner claude
needlefish --repo /path/to/some-repo --runner opencode --model zai-coding-plan/glm-5.2
```

Output: Markdown to stdout, JSON saved to `~/.cache/needlefish/<repo>/last-review.json`.

## Base detection

`--base` → `origin/HEAD` → `main`. Pass `--base <ref>` to override.

## GitHub Action mode (self-hosted runner)

`needlefish --github --pr N` collects the PR via `gh api`, runs the same core,
and posts a formal PR review (`REQUEST_CHANGES` / `COMMENT`) with the full
rendered review body plus a check run. Verdict → surface mapping:

| verdict              | review event        | check     |
| -------------------- | ------------------- | --------- |
| pass                 | COMMENT             | success   |
| changes_requested    | REQUEST_CHANGES     | failure   |
| needs_human          | COMMENT             | neutral   |
| run failed           | (none)              | failure   |

`pass` posts a `COMMENT` (not `APPROVE`) plus a green check: the `GITHUB_TOKEN`
bot is not permitted to formally approve PRs (anti-self-approval), so the green
check-run is the merge gate. A failed review never passes a PR — the check goes
`failure`.

### Runner setup (one-time)

Target repos consume needlefish by **calling the reusable workflow** in this
repo. Add a thin caller in the target repo (e.g. `.github/workflows/needlefish.yml`):

```yaml
name: needlefish
on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      pr_number: { description: PR number to review (manual trigger), required: true }
permissions:
  contents: read
  pull-requests: write
  checks: write
jobs:
  review:
    uses: frankekn/needlefish/.github/workflows/review.yml@main
    with:
      pr_number: ${{ github.event.inputs.pr_number || github.event.pull_request.number }}
      # Optional:
      # runner: codex
      # model: gpt-5.5
      # timeout_ms: "600000"
    secrets: inherit
```

Because the caller pins `@main`, fixes to needlefish's `review.yml` propagate to
every target repo automatically — no per-repo update needed. (Alternatively,
copy `review.yml` into the target repo if you want it frozen.)

1. Register a **self-hosted runner** on the target repo (free, unlimited minutes).
   Keep it on a machine you control (EC2/pod/Mac).
2. Ensure the runner has `gh` and the selected model CLI on `PATH`.
3. On that runner, auth the selected CLI once. For Codex:
   ```bash
   printf '%s' "$CODEX_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
   ```
4. If needlefish is **private**, the caller's `secrets: inherit` needs a PAT with
   access to this repo available to the target; otherwise (public) the default
   `GITHUB_TOKEN` is enough.
5. **Runner global-instructions caveat:** model CLIs may auto-load global
   instructions from the runner's home directory. needlefish instructs the model
   to ignore anything outside the target repo's `AGENTS.md` as policy, but if
   you want zero leakage, keep the runner home free of unrelated instruction
   files.

> Self-hosted runners execute PR code on your machine. Fine for solo use on your
> own repos; if you ever open PRs to outside contributors, isolate the runner
> (ephemeral container) so contributor code can't touch your persistent host.

## Model runner invocation

`src/shared/codex.ts` shells out to the selected CLI. Use `--runner`, `--model`,
and `--timeout-ms`, or the matching env vars:

| option | env | default |
| --- | --- | --- |
| runner | `NEEDLEFISH_RUNNER` | `codex` |
| model | `NEEDLEFISH_MODEL` | runner default |
| timeout | `NEEDLEFISH_TIMEOUT_MS` | `600000` |

Runner-specific binary env vars are `CODEX_BIN`, `CLAUDE_BIN`, and
`OPENCODE_BIN`. Existing `CODEX_MODEL`, `CODEX_TIMEOUT_MS`, and
`CODEX_RETRY_MS` still work for Codex compatibility.

Codex runs with `-s read-only`. Claude Code runs with `--permission-mode plan`,
`--safe-mode`, and no session persistence. opencode runs with `--pure` and never
uses `--dangerously-skip-permissions`. Non-Codex runners execute inside a
throwaway clean clone at the review head commit; needlefish checks that sandbox
with `git status --porcelain --untracked-files=all --ignored=matching` and
verifies `HEAD` did not move after each successful model call.

## Verdict derivation (deterministic)

- any P0 / P1 / P2 finding → `changes_requested`
- otherwise a blocking residual risk → `needs_human`
- otherwise → `pass`

P3-only findings are reported but do not block (check stays green).

## Status

v0.2. Read-only. `--fix` and `@needlefish` comment commands are in
`FUTURE_TODO.md`. Every push re-triggers the action, so server-side re-review is
automatic; `--recheck` is a local affordance only.
