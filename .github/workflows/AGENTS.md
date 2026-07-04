# WORKFLOWS KNOWLEDGE BASE

## OVERVIEW

`.github/workflows/` is runtime behavior for Needlefish itself: reusable PR review and deploy-on-main for the self-hosted runner.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| PR review workflow | `review.yml` | Reusable via `workflow_call`, manual via `workflow_dispatch`, and local repo PR trigger. |
| Deploy workflow | `deploy.yml` | Push to `main` runs `scripts/deploy-ubuntu.sh` on self-hosted runner. |

## CONVENTIONS

- Review workflow runs on `self-hosted`.
- Caller repos are expected to use `frankekn/needlefish/.github/workflows/review.yml@main`.
- The runner must already have `~/.local/bin/needlefish`; workflow should fail clearly if missing.
- Use `permissions: contents: read`, `pull-requests: write`, `checks: write` for review posting.
- Use concurrency keyed by repo and PR number to cancel stale runs.
- Skip closed PR events and forked PR heads.

## ANTI-PATTERNS

- Do not install Needlefish on every PR review run; deploy is separate.
- Do not broaden workflow permissions without a concrete posting need.
- Do not run untrusted fork PR code on the persistent self-hosted runner.
