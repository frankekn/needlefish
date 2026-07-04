# Future TODO

Deferred by design (v0.1 is read-only, local-diff + self-hosted action).

## Recall stability (from the over-block/budget trigger work)
RESOLVED 2026-07: after switching the small-path diff to raw sentinel text and
the default effort to medium, over-block recall measured 10/10 across
`pos-over-block` and `pos-over-block-shared` (5 draws each) with no sweep. A
conditional gating-sweep pass was built, failed its A/B gate (no recall gain,
+50% calls when triggered), and was reverted — see eval/RESULTS.md. Revisit
only if over-block regressions reappear on real PRs.

## dead-public-API blind spot
RESOLVED 2026-07: W3 closed this as a documented limitation (detection-side
experiments exhausted), then W4's criticPruneError diagnosis showed the review
pass found the bug every draw and the critic deleted it. A narrow critic.md
exception (public error handling is consumer-facing; "no in-repo caller" does
not justify deletion) fixed it: go-backend-slop-swallow 0/3 -> 3/3, full gate
non-inferior, criticPruneErrorRate 0.0556 -> 0. See eval/RESULTS.md W4.

## Issue-comment commands
RESOLVED 2026-07: maintainer commands shipped as `@needlefish recheck` and
`@needlefish explain`; `recheck` is the forced-review path.

## Repair lane (`--fix`)
Let needlefish mutate the branch and push a fix (ClawSweeper-style bounded repair
loop). v0.1 is report-only; `--fix` is parsed but errors out.

## Action packaging
RESOLVED 2026-07: shipped composite `action.yml` for
`uses: frankekn/needlefish@v0`; reusable workflow support remains available.

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
