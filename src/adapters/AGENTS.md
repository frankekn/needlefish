# ADAPTERS KNOWLEDGE BASE

## OVERVIEW

`src/adapters/` translates local CLI and GitHub Action inputs into the same core review bundle, then handles surface-specific output.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Local diff review | `local.ts` | Uses merge-base..HEAD and warns that dirty worktree changes are excluded. |
| Local PR review | `local.ts` | Uses `gh pr view`, fetches refs, and reads `AGENTS.md` at PR head. |
| GitHub Action review | `github.ts` | Uses Actions env, PR API, check-runs, and review comments. |
| Posting behavior | `github-posting.test.ts` | Stale head and non-sticky comment behavior are protected here. |

## CONVENTIONS

- Normalize repo paths before passing them to core review.
- Re-read PR state before posting. Closed PRs and stale heads must produce no review/check output beyond the skip notice.
- Local mode may cache under `~/.cache/needlefish`; GitHub mode posts to GitHub.
- GitHub `changes_requested` sets process exit code 1 and failed check-run, but posts review event `COMMENT`.

## ANTI-PATTERNS

- Do not include uncommitted local changes in local review; this tool reviews merge-base..HEAD.
- Do not make GitHub review output sticky by using `REQUEST_CHANGES`.
- Do not let `GITHUB_TOKEN`, `GH_TOKEN`, or runner auth leak into model-runner subprocesses; shared runner code strips these.
