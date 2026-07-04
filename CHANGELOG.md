# Changelog

## Unreleased

- CLI: add `--json` ReviewResult output with `schemaVersion: 1` as the stable machine interface.
- Runner timeouts now terminate the runner process group, wait a configurable grace period, then hard-kill the group to prevent orphaned subprocesses.
- Runner timeouts now give up waiting after post-SIGKILL pipes stay open, and blank runner timeout env values fall back to defaults.

## 0.3.0 — 2026-07-02

### Changes

- Eval: add `--holdout include|exclude|only` (default `include`) so plain runs always tell the full truth, prompt-tuning iteration can `exclude` sealed holdouts, and final gates can run `only` them; the mode is recorded in the report JSON. Add a critic prune-error metric: under `NEEDLEFISH_EVAL_TRACE` the review result carries pre-critic `candidateFindings`, and the eval scores per-draw `criticPruneError` (a mustFind hit present before the critic but missing after) aggregated into `criticPruneErrorRate` over positive fixtures.

- Docs-only fast path: when every changed file is classified `docs`, skip model calls and return a deterministic pass (`NEEDLEFISH_NO_FAST_PATH=1` disables). Same-head dedupe: GitHub mode skips re-reviewing a head already reviewed unless `--recheck` is passed (wired through `@needlefish recheck` manual dispatch).

- Restore in-sandbox repo inspection (rg/git) for codex on GitHub-hosted Linux runners by lifting the AppArmor unprivileged-userns restriction (best-effort sysctl in the action).
- Sticky re-review: on a re-review of the same PR, Needlefish now PUT-updates its previous review body instead of posting a new one, classifying findings as fresh / open / resolved across rounds (inline comments posted only for fresh anchorable findings; open findings listed as one-liners; resolved count shown as a single line).

- Add `@needlefish recheck` / `@needlefish explain <text>` PR comment commands (maintainers only) and a `needlefish explain` CLI mode that posts a one-call deep explanation of a single finding.
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
