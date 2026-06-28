<p align="center">
  <img src="assets/banner.png" alt="Needlefish" width="100%">
</p>

# needlefish

Strict local PR review agent. Acts like a senior engineer reviewing your diff
before merge — only real defects (bugs, regressions, security, data loss,
migration/upgrade risk, missing validation, duplicate behavior), never style.

Read-only by default. Two Codex calls per review: a deep pass, then an
adversarial critic that prunes weak findings. Verdict is derived deterministically
from the surviving findings, never freehanded by the model.

## Install

Requires Node 20+, pnpm, and the Codex CLI authed locally.

```bash
git clone https://github.com/frankekn/needlefish
cd needlefish
corepack enable
pnpm install
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
```

Output: Markdown to stdout, JSON saved to `~/.cache/needlefish/<repo>/last-review.json`.

## Base detection

`--base` → `origin/HEAD` → `main`. Pass `--base <ref>` to override.

## GitHub Action mode (self-hosted runner)

`needlefish --github --pr N` collects the PR via `gh api`, runs the same core,
and posts a formal PR review (`APPROVE` / `REQUEST_CHANGES` / `COMMENT`) with
line-anchored inline comments plus a check run. Verdict → surface mapping:

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
    secrets: inherit
```

Because the caller pins `@main`, fixes to needlefish's `review.yml` propagate to
every target repo automatically — no per-repo update needed. (Alternatively,
copy `review.yml` into the target repo if you want it frozen.)

1. Register a **self-hosted runner** on the target repo (free, unlimited minutes).
   Keep it on a machine you control (EC2/pod/Mac).
2. On that runner, auth Codex non-interactively once (persisted):
   ```bash
   printf '%s' "$CODEX_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
   ```
3. If needlefish is **private**, the caller's `secrets: inherit` needs a PAT with
   access to this repo available to the target; otherwise (public) the default
   `GITHUB_TOKEN` is enough.
4. **Codex global-instructions caveat:** the Codex CLI auto-loads global
   instructions from `~/.codex/` on the runner. needlefish instructs the model
   to ignore anything outside the target repo's `AGENTS.md` as policy, but if
   you want zero leakage, keep the runner's `~/.codex/` free of unrelated
   instruction files (e.g. `RTK.md`).

> Self-hosted runners execute PR code on your machine. Fine for solo use on your
> own repos; if you ever open PRs to outside contributors, isolate the runner
> (ephemeral container) so contributor code can't touch your persistent host.

## Codex invocation

`src/shared/codex.ts` shells out to `codex exec` (prompt via stdin), reading
`CODEX_BIN`, `CODEX_MODEL`, `CODEX_TIMEOUT_MS` from env. If your installed
Codex CLI uses different exec flags, adjust that one file.

## Verdict derivation (deterministic)

- any P0 / P1 / P2 finding → `changes_requested`
- otherwise a blocking residual risk → `needs_human`
- otherwise → `pass`

P3-only findings are reported but do not block (check stays green).

## Status

v0.1. Read-only. `--fix` and `@needlefish` comment commands are in
`FUTURE_TODO.md`. Every push re-triggers the action, so server-side re-review is
automatic; `--recheck` is a local affordance only.
