# Finding confidence contract repair — 2026-09-26

## Evidence and scope

- Production run 36244719273 rejected a deep pass with `blocking finding has low confidence`; coverage was 43/54. This is semantic validation, not evidence of malformed JSON syntax.
- `normalizeFinding` requires confidence >= 0.7 for P0/P1/P2. The small-review prompt described that restriction, but deep and critic did not. Both finding examples used confidence 0.0.
- `runJsonPrompt` already re-asks on parsing/validation failure (two attempts for deep, three for critic). Blind extra retries do not repair the missing contract.
- The ephemeral production instance is gone and its only uploaded artifact contains run/head identity, not model output. The rejected finding's exact text and confidence cannot be recovered from those artifacts; do not invent them.
- Candidate centralizes the existing admission rule in one shared prompt fragment, packages and hashes it, and prevents severity from being used as a substitute for confidence. Validator, verdict rules, candidate containment, and retry count remain unchanged.

## Predeclared Class R gate

- Freeze the prompt wording before model evaluation. Add the sealed `holdout-runbook-unobserved-rollout` fixture before either run; no target-repo identifiers or transcript-derived answer key.
- Run both control (93cae2a plus the new fixture) and candidate on all 88 fixtures, holdouts included, Codex → CLIProxyAPI → DeepSeek V4.1 Flash, high effort. No other model version is allowed.
- Initial full-set draw is descriptive only. Confirm x3 on every divergent fixture and on any Tier-1 miss or malformed-output fixture. Preserve every failed draw; do not rerun until green.
- Require candidate Tier-1 recall 1, zero malformed-output errors, zero cheat detections, and no confirmed recall/noise regression. Failure rejects the candidate; restore the shipping prompts and record results.
- Prompt hashes intentionally differ between control and candidate: do not use `--compare` or present this as a same-contract leaderboard comparison. Fixture set and anticheat version must match; compare per-fixture observations explicitly.
- Unit admission boundaries and prompt rendering, package smoke, typecheck/lint, and independent scoped review must pass before promotion. Shared-runner promotion additionally requires a rollback-equipped live canary.

## Initial local verification

- New prompt-contract regressions: 3 red before repair; 43 prompt/normalizer tests green after repair.
- Typecheck and lint pass. Full suite: 1,105 pass, 2 fail because historical README benchmark tests require every historical lane to contain newly authored fixtures. Resolve that historical-publication coupling without weakening the production eval gate before shipping.
- Shared runner remains rolled back to the previous release throughout this investigation.
