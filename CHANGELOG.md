# Changelog

## 0.3.5 — 2026-07-15

- Runner: add explicit local/self-hosted Kiro CLI support through a disposable
  read/grep-only custom agent with file-URI prompts. Leading Kiro tool traces are
  retained in raw transcripts while JSON calls parse only the valid final
  payload. Guarded IAM auth is copied to Kiro's disposable HOME data path;
  production prefers `KIRO_API_KEY` when configured and otherwise uses the
  sanitized auth-DB fallback.
- CLI/CI: add generic `--effort` with fail-closed validation for unsupported
  runners; default self-hosted reviews and weekly evals to Kiro
  `gpt-5.6-luna` at `xhigh`. Hosted action installation remains
  unchanged and does not include Kiro.

## 0.3.4 — 2026-07-15

- Tests: isolate OpenCode's XDG config/data roots so ephemeral-home coverage is
  deterministic on GitHub-hosted runners.

## 0.3.3 — 2026-07-15

- Eval: add fail-closed anti-cheat guards with per-draw ephemeral HOME,
  answer-key canaries, and full-transcript scanning.
- Review: harden coverage, error-path, round-comment, and report-integrity
  handling across local and GitHub review paths.
- GitHub: support an explicit Grok 4.5 review lane and keep review sandboxes
  on the runner's temporary storage.
- Docs: document the self-hosted Grok 4.5 GitHub workflow.

## 0.3.2 — 2026-07-07

- CLI: `--version` now reads the version from package.json at runtime instead of a hardcoded string (0.3.1 still reported "0.3.0").

## 0.3.1 — 2026-07-07

First version published to npm. (An `0.3.0` build with the same content was also published to npm from a commit ahead of the `v0.3.0` git tag; `0.3.1` is the release whose git tag matches the npm tarball.)

- WORKING sandbox: ensure a trailing newline before `git apply` to fix corrupt-patch errors, with a regression test.
- Package: add a buildable npm package layout for `npx needlefish`, with packaged prompts and automatic local runner detection (`codex` -> `claude` -> `opencode`).
- Local mode now reviews uncommitted changes by default when the working tree is dirty or the repo has no commits yet (untracked files included, gitignore respected, binary/empty/oversize skipped with notes). `--branch` forces the old merge-base review; `--uncommitted` forces working-tree review. Non-git folders get a friendly `git init` hint.
- Critic: keep findings about newly weakened error handling in exported/public symbols even with zero in-repo callers, and tighten the contract-drift exception to promises that affect what callers actually receive. Resolves the go-backend-slop-swallow documented limitation (criticPruneErrorRate 0.0556 -> 0).
- GitHub suggestion replacements with fence-breaking backticks or embedded newlines are now omitted instead of rendering unsafe suggestion blocks.
- GitHub mode now appends native suggestion blocks to inline comments only after deterministic replacement validation.
- CLI: add `--json` ReviewResult output with `schemaVersion: 1` as the stable machine interface.
- Runner: add `acp` for one-shot Agent Client Protocol agents via `NEEDLEFISH_ACP_BIN`, with protocol cancel on top of the existing process-group brakes.
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
