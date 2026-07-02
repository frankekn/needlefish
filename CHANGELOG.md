# Changelog

## Unreleased

### Changes

- Add `needlefish pr <number>` for reviewing pull request refs locally without switching branches. (#7) thanks @samzong
- Run deep passes concurrently on large PRs (`NEEDLEFISH_DEEP_CONCURRENCY`, default 3; 1 restores sequential order of execution — output order is always stable).
- Re-ask the model once when it emits malformed or unusable JSON instead of failing the whole review; runner safety errors still abort immediately.
- Record per-call stats (label, duration, attempts) in the review result and append a summary line to the rendered Markdown.
- Make large-path thresholds env-overridable (`NEEDLEFISH_LARGE_PATCH_CHARS`, `NEEDLEFISH_LARGE_FILE_COUNT`).
- Feed the small-path diff to the model as raw text between sentinel lines instead of escaped JSON inside the bundle.
- Ship a composite `action.yml` so any repo can run reviews on GitHub-hosted runners; `review.yml` gains `runs_on` and `needlefish_repo` inputs (defaults unchanged).
