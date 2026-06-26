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

## Local use (read-only, no GitHub writes)

Run from inside any repo you want reviewed, on a branch with changes:

```bash
# Option A — run from inside the target repo (cwd is the target):
cd /path/to/some-repo
/path/to/needlefish/node_modules/.bin/tsx /path/to/needlefish/src/cli.ts

# Option B — point at the target with --repo from anywhere:
tsx /path/to/needlefish/src/cli.ts --repo /path/to/some-repo --focus security
tsx /path/to/needlefish/src/cli.ts --repo /path/to/some-repo --deep
tsx /path/to/needlefish/src/cli.ts --repo /path/to/some-repo --pr 123  # pulls PR metadata via gh
tsx /path/to/needlefish/src/cli.ts --repo /path/to/some-repo --base develop
```

Tip: alias it — `alias needlefish="tsx $HOME/Github/needlefish/src/cli.ts"`,
then `needlefish --repo .` from any repo.

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

The workflow lives in the **target** repo (`.github/workflows/review.yml`),
not in needlefish — copy it from this repo. It checks out needlefish as a tool.

1. Register a **self-hosted runner** on the target repo (free, unlimited minutes).
   Keep it on a machine you control (EC2/pod/Mac).
2. On that runner, auth Codex non-interactively once (persisted):
   ```bash
   printf '%s' "$CODEX_API_KEY" | codex login --with-api-key -c 'service_tier="fast"'
   ```
3. If needlefish stays **private**, set a PAT secret (`NEEDLEFISH_PAT`) and
   uncomment the `token:` line in the workflow's needlefish checkout step.
   If needlefish is **public**, the default `GITHUB_TOKEN` is enough.

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
