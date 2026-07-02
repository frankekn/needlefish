# Future TODO

Deferred by design (v0.1 is read-only, local-diff + self-hosted action).

## Recall stability (from the over-block/budget trigger work)
RESOLVED 2026-07: after switching the small-path diff to raw sentinel text and
the default effort to medium, over-block recall measured 10/10 across
`pos-over-block` and `pos-over-block-shared` (5 draws each) with no sweep. A
conditional gating-sweep pass was built, failed its A/B gate (no recall gain,
+50% calls when triggered), and was reverted — see eval/RESULTS.md. Revisit
only if over-block regressions reappear on real PRs.

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

## Hosted-runner repo inspection
RESOLVED 2026-07: root cause was Ubuntu 24.04 AppArmor blocking unprivileged
user namespaces (bwrap). Verified by probe on ubuntu-latest: after
`sysctl kernel.apparmor_restrict_unprivileged_userns=0`, rg/git run fine
inside the codex read-only sandbox. action.yml now applies the sysctl
best-effort on Linux runners with passwordless sudo; runners without sudo
keep the documented diff-only degradation.
