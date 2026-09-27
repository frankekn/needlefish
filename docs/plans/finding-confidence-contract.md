# Finding confidence contract repair — 2026-09-26

## Evidence and scope

- Production run 36244719273 rejected a deep pass with `blocking finding has low confidence`; coverage was 43/54. This is semantic validation, not evidence of malformed JSON syntax.
- `normalizeFinding` requires confidence >= 0.7 for P0/P1/P2. The small-review prompt described that restriction, but deep and critic did not. Both finding examples used confidence 0.0.
- `runJsonPrompt` already re-asks on parsing/validation failure (two attempts for deep, three for critic). Blind extra retries do not repair the missing contract.
- The ephemeral production instance is gone and its only uploaded artifact contains run/head identity, not model output. The rejected finding's exact text and confidence cannot be recovered from those artifacts; do not invent them.
- CLIProxyAPI also has request logging and file logging disabled, so no proxy-side raw transcript was available to fill that gap.
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

## Verification progress

- Historical README checks now validate the published baseline's fixture membership and prompt identity; live evaluator and publication completeness checks are unchanged. All 1,107 tests, typecheck, lint, and package-install smoke pass. A transient process-SIGINT test failure on an intermediate run passed its isolated rerun and final full suite; no signal-handling code changed.
- Independent commit review of `45e7252` with explicit `--max-priority P2` found no actionable P0–P2 defects. (The helper's default P0-only scope is insufficient for this change.)
- Initial full-set control and candidate each completed all 88 draws with zero invalid-output rate, zero cheats, and Tier-1 recall 1. Control recall 56/61, candidate 53/61; noise per positive 2/61 versus 0. These are single-draw observations, not a regression verdict.
- x3 confirmation finished for nine recall/verdict/noise-divergent fixtures and seven additional finding-count-divergent fixtures, on both versions. Candidate recall is 38/48 vs control 34/48, with no per-fixture decrease; extra findings 1 vs 4. The frontend fixture's one extra finding switched sides between initial/confirmation, totaling 1/4 in both versions. Invalid-output and cheat counts are zero throughout. Offline gate passes; no prompt wording changed after full-set evaluation began.
- All 272 draws are preserved in `eval/evidence/2026-09-26-confidence/`. The candidate's initial weaker recall is retained, not hidden. Live canary remains a separate gate.

## Independent trail audit and adjudication

Claude Fable 5 reviewed the decision trail, gate plan, confirmation table, and
code-review result. It did not receive the entire session transcript or initial
per-fixture reports; its coverage is limited to those supplied artifacts.

- Live result is pending. Accepted; promotion cannot be called successful before the exact-head check and coverage are read back.
- Noise criterion needs explicit adjudication. The repository defines `meanNoisePerPositive` as the precision signal. On the same 48 confirmation draws this is 4/48 control versus 1/48 candidate. The one frontend extra finding also appeared in control's initial draw; both total 1/4. We interpret “no confirmed noise regression” as no sustained regression, not “every random draw has zero extras.” No draw is excluded, no threshold changed, and this judgment is explicit rather than hidden behind the aggregate. This does not claim significance from three draws.
- Second shipped commit review was not supplied. Accepted; run an explicit P0–P2 review of `0894cc0` before allowing promotion. The previous summary-fix review was only P0-wide. `45e7252` already has a P0–P2 clean review.
- Original production output remains unavailable. Accepted limitation. The same error also covers missing/null confidence becoming zero in the normalizer; we cannot assert which raw value the model emitted. The mismatch between required and supplied contracts is verified, not a uniquely proven reconstruction of that discarded output.
- SIGINT flake and historical README-test scope are disclosed above. Live evaluator/publisher validation was not changed. Complete initial reports and all confirmation reports are now archived for independent recomputation of the divergence set.
- Model identity is verified at the requested CLI/API model-ID boundary, not by introspection into the remote provider's implementation. No V4 Flash fallback was configured for these evals.

The live promotion script now requires an `offline-gate-approved` artifact before
it can switch AMIs, so missing adjudication/review cannot race with AMI readiness.

## Follow-through

- The wider P0–P2 review of `0894cc0` found exactly one finding and no other P0–P2 defects: a suffix link can be swallowed by an unclosed Markdown construct at truncation. `a131be2` prepends the notice. HTML-comment and code-fence regressions failed 2/2 before the fix and pass afterward, including supplementary-Unicode round-trip. P0–P2 fix review is clean. Self.5 was withheld before promotion; self.6 contains the repair.
- The signal flake recurred. In a separate worktree, the unchanged whole-file test reproduced the same race on iteration 3 (SIGTERM). Linux exits the owner after sending SIGKILL without waiting for the detached process to be reaped. `3817064` corrects the verifier with polling inside the original total two-second deadline. Runtime code is unchanged. Ten consecutive whole-file runs and an independent P0–P2 review passed; final full suite is 1,108/1,108, plus typecheck/lint/package smoke.
- This test-only fix is not a model/prompt change. The link repair is posting-only. The Class R model-path inputs and validator are unchanged from the archived 272 draws, so those results remain the applicable model gate.
- The final release's real AMI smoke passed: all three shared contracts rendered, the link is prepended, hashes verified, and Codex 0.155.1/Node 24.21.0/Needlefish 0.4.6 ran. Live run `36258643489` and check `108450740558` passed on exact head `6aa8550d0b1875acd8ae66b85753be16292905e4`: 54/54 files, six hotspots, eight calls, 26m38s, no actionable findings and no reported output retries. Self.6 remains promoted.
- The 60,084-byte live summary did not reach the truncation branch. Oversized UTF-8/Markdown regressions and exact-bundle tests pass, but there is no live oversized-publication claim. The original failed raw JSON remains unavailable.
- The old failed PR workflow `36223355738` was rerun after the real full canary. Attempt 2 succeeded through authenticated `same_head` dedupe; it is not another model draw or replacement for the real canary. PR-body contract run `36260777714` passed; all current-head checks pass and unresolved threads are zero. Saiens merge/deploy and writer-fencing/rollback decisions remain outside this execution.
- Final Claude Fable 5 decision-trail audit closes all three earlier blockers with no remaining blocker. Its documentation nit—explicitly naming `0894cc0` as the reviewed summary commit—is resolved above. Receipt: `eval/evidence/2026-09-26-confidence/trail-audit.md`.
