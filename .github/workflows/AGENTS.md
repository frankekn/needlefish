# WORKFLOWS KNOWLEDGE BASE

## OVERVIEW

`.github/workflows/` is runtime behavior for Needlefish itself: own-repo CI, reusable PR review, and gated deploy-on-main for the self-hosted runner.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Own-repo CI | `ci.yml` | PRs and pushes to `main` on `ubuntu-latest`. Required check name: `needlefish-ci`. |
| PR review workflow | `review.yml` | Reusable via `workflow_call`, manual via `workflow_dispatch`, and local repo PR trigger. |
| Deploy workflow | `deploy.yml` | `workflow_run` after a successful `needlefish-ci` **push** to `main`, plus `workflow_dispatch`. Deploys `NEEDLEFISH_REF=<verified SHA>`. |

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
- Do not run own-repo CI on `self-hosted`.
- Do not deploy `main`'s current tip from a `workflow_run`; deploy `head_sha`.
- Do not let a `pull_request` `workflow_run` deploy; filter `event == 'push'`.
