# Changelog

## Unreleased

### Changes

- Post anchorable findings as inline PR review comments on the diff (RIGHT side), capped at 20 with P0/P1/P2 priority; non-anchorable and overflow findings stay in the review body.
- Add TRIGGER C (contract drift: renamed/documented promises the body does not implement) and TRIGGER D (swallowed failure: discarded error signals) to the review and deep prompts, with a critic exception so contract-drift findings survive the naming-only prune; triggers are explicitly not a bug taxonomy.

- Add `needlefish pr <number>` for reviewing pull request refs locally without switching branches. (#7) thanks @samzong
- Run deep passes concurrently on large PRs (`NEEDLEFISH_DEEP_CONCURRENCY`, default 3; 1 restores sequential order of execution — output order is always stable).
- Re-ask the model once when it emits malformed or unusable JSON instead of failing the whole review; runner safety errors still abort immediately.
- Record per-call stats (label, duration, attempts) in the review result and append a summary line to the rendered Markdown.
- Make large-path thresholds env-overridable (`NEEDLEFISH_LARGE_PATCH_CHARS`, `NEEDLEFISH_LARGE_FILE_COUNT`).
- Feed the small-path diff to the model as raw text between sentinel lines instead of escaped JSON inside the bundle.
- Default codex reasoning effort is now `medium` (was `high`): on the 34-fixture eval it matched or beat `xhigh` recall at 3.3x the speed. Set `CODEX_REASONING_EFFORT` to restore the old behavior.
- Ship a composite `action.yml` so any repo can run reviews on GitHub-hosted runners; `review.yml` gains `runs_on` and `needlefish_repo` inputs (defaults unchanged).
