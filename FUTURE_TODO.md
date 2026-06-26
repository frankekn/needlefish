# Future TODO

Deferred by design (v0.1 is read-only, local-diff + self-hosted action).

## Issue-comment commands
`@needlefish recheck` / `@needlefish review` / `@needlefish explain` via `issue_comment`
trigger. v0.1 only auto-reviews on `pull_request` events.

## Repair lane (`--fix`)
Let needlefish mutate the branch and push a fix (ClawSweeper-style bounded repair
loop). v0.1 is report-only; `--fix` is parsed but errors out.

## Action packaging
Ship as a reusable `action.yml` (Docker/node20) so others can `uses: frankekn/needlefish@v1`.
v0.1 runs via workflow checkout + `pnpm review --github`.

## Multi-repo config
Per-repo config file (base branch, severity gates, focus defaults) instead of flags only.

## Critic parallelism / depth
Optional second critic model or deeper call-site archaeology (`--deep` currently only
widens prompt framing).
