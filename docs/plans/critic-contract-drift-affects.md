# Critic contract-drift clause: "affects", not "changes vs base"

Class R. Declared before the gate run on 2026-09-30.

## Defect

`prompts/critic.md` kept a contract-drift finding only when the unmet promise
"changes the result … a caller actually receives". Critics read "changes" as a
base-vs-head delta. A rename that newly promises a behavior over an unchanged
body produces no delta, so the critic deleted it as naming-only. Captured
critic output on `rs-backend-spec-drift`: "the diff changes only the two
identifier occurrences … No return value … differs before vs after … Deleted
per the naming-only rule". `prompts/review.md` Trigger C uses "affects": the
promise contradicts what the body returns for a caller.

Pre-change baseline, DeepSeek V4.1 Flash high x3, prompt `d95aa170f3a37cf3`
(`eval/results/2026-09-30-codex-deepseek-v41-flash-high-x3.json`): recall
0.907, tier-1 1.0, FP 0/78, noise 0.027, `criticPrunedRecallCount` 5, all on
contract drift (`rs-backend-spec-drift` 3/3 pruned, `py-backend-spec-drift` 1,
`py-backend-flag-ignored` 1). Under the old prompt `e62d0889fc704541` the same
lane pruned none of them.

## Change

The clause now says "affects", tells the critic to substitute an input the
promise excludes and check the HEAD output, states that a byte-identical body
never clears the finding, and restricts deletion to unused inputs that promise
nothing about output and to names that describe what the body already does.
The 2026-07-04 guard against `go-harmless-variadic` false positives is kept.

New sealed holdout, authored before any run: `holdout-descriptive-rename`
(negative; an accurate descriptive rename must stay clean).

## Gate (pre-declared)

Lane: codex, `deepseek/deepseek-v4.1-flash`, effort high, CLIProxyAPI route,
full fixture set, x3, holdouts included, `--gate-class R`.

Pass requires all of:

1. `cheatDetectedCount` 0 and complete coverage.
2. Tier-1 recall 1.0.
3. `rs-backend-spec-drift`, `py-backend-spec-drift`, `py-backend-flag-ignored`,
   `holdout-spec-drift`: 3/3 each.
4. `criticPrunedRecallCount` ≤ 2 (baseline 5).
5. Zero false positives on `go-harmless-variadic`, `holdout-descriptive-rename`,
   and every other negative; overall FP ≤ 1/81 draws.
6. `meanNoisePerPositive` ≤ 0.05 (baseline 0.027; qualification cap 0.12).
7. Anchored recall ≥ 0.89 (baseline 0.907 minus one-fixture flicker).

Fail on any item → revert `prompts/critic.md`, keep the holdout, record the
data in `eval/RESULTS.md`.

## Round 1 result (2026-09-30)

Failed criterion 5: one false positive on `go-harmless-variadic` (the
"caller-supplied argument the promise says is honored" wording let an unused
variadic read as a promise). Reverted in `48ae9db`; data in `eval/RESULTS.md`.

## Round 2 (declared before the run)

Change: keep "affects", HEAD-output substitution, and "a body byte-identical
to base never clears a newly promised behavior". Drop the caller-supplied
argument clause. State that only a promise of a listed output property counts
and a parameter's mere presence promises nothing; restore the original
deletion sentence for unused inputs and labels.

New sealed holdout: `holdout-unused-keyword-arg` (negative, Python).

Gate: same lane and criteria 1–7 as round 1, with criterion 5 extended to
`holdout-unused-keyword-arg`. Fail → revert and record.

## Round 2 result (2026-09-30)

Failed criteria 3 and 4: zero false positives, but `py-backend-flag-ignored`
0/3, all critic-pruned. Reverted; data in `eval/RESULTS.md`. Prose alone moves
the boundary between the `limit`/variadic pair each round. Next candidate is a
structural change to the critic's evidence contract, not another wording.

## Round 3 (declared before the run)

Structural change instead of wording. The critic prose is back to the
original `d95aa170f3a37cf3` clause, plus one output-shape rule: every deleted
`contract` finding needs a `checked[]` record

`CONTRACT_DROP candidate=<i> file=<f> promised=<property|none> input=<x> head_output=<y> violates=yes|no`

`src/core/review.ts` (`refutedContractDrops`) restores a deleted
contract-category candidate verbatim when its own record says `violates=yes`
and the file matches. Only deleted candidates, each at most once; restored
content comes from the candidate bag, so the result stays a subset of the
candidate findings. Round 1 and 2 traces show the critic stating the
violation and deleting anyway; this takes the keep/delete decision from the
recorded substitution instead of the critic's conclusion.

New sealed positive holdout: `holdout-clamp-rename-drift`.

Gate: same lane; criteria 1–7 with criterion 3 extended to
`holdout-clamp-rename-drift` and criterion 5 covering
`go-harmless-variadic`, `holdout-descriptive-rename`,
`holdout-unused-keyword-arg`. Fail → revert and record.

## Round 3 result (2026-10-01)

Failed criteria 3, 4, 7 and one invalid output. Reverted; data in
`eval/RESULTS.md`. Rename-introduced promises are fixed by every candidate;
the unused-`limit` case and non-contract prunes flicker per draw.

## Round 1 x10 confirmation (option A, declared 2026-10-01 before any draw)

Question: is round 1 (`46d207a`, prompt `c59d803f0d0dc476`) better than
control (`d95aa170f3a37cf3`) on contract drift once per-draw flicker is
averaged out, without a real false-positive cost?

Both arms run from the same commit in separate worktrees; only
`prompts/critic.md` differs. Same lane (codex → CLIProxyAPI →
`deepseek/deepseek-v4.1-flash`, high), 10 draws, holdouts included, both arms
concurrently at concurrency 3.

Contract positives (5 × 10 = 50 draws): `rs-backend-spec-drift`,
`py-backend-spec-drift`, `py-backend-flag-ignored`, `holdout-spec-drift`,
`holdout-clamp-rename-drift`.
Contract-adjacent negatives (8 × 10 = 80 draws): `go-harmless-variadic`,
`holdout-descriptive-rename`, `holdout-unused-keyword-arg`,
`neg-harmless-default`, `neg-safe-tightening`, `rs-refactor`,
`py-safe-refactor`, `neg-hard-refactor-move`.
Reported only: `go-backend-slop-swallow` (critic-sensitive, not contract).

Round 1 is confirmed better only if all hold:

1. Positive hits: candidate − control ≥ 5 of 50, and one-sided Fisher exact
   p < 0.05.
2. Candidate false positives ≤ 2 of 80 and ≤ control + 2.
3. `go-harmless-variadic` candidate false positives ≤ 1 of 10.
4. Cheat 0 and invalid output ≤ 1 per arm.

Confirmed → re-propose round 1 for the full Class R gate with a
pre-declared draw-count-aware criterion. Not confirmed → round 1 is
abandoned; the rename defect stays open.

## Round 1 x10 confirmation result (2026-10-01)

| | Control `d95aa170` | Round 1 `c59d803f` |
| --- | ---: | ---: |
| Contract positives (5 fixtures) | 40/50 | **49/50** |
| — critic-pruned | 10 | **0** |
| Adjacent-negative FP | 1/80 | 2/80 |
| `go-harmless-variadic` FP | 0/10 | 1/10 |
| Cheat / invalid | 0 / 0 | 0 / 0 |

Diff +9, one-sided Fisher p = 0.0039. Criteria 1–4 all hold: **confirmed**.
Evidence: `eval/evidence/2026-10-01-critic-r1-x10/`.

## Round 1 full gate, draw-count-aware (declared before the run)

Same lane, full fixture set (91), x3, holdouts included. Single-fixture 3/3
requirements are replaced by pooled counts sized from the x10 rates.

1. Tier-1 recall = 1.
2. Contract positives (`rs-backend-spec-drift`, `py-backend-spec-drift`,
   `py-backend-flag-ignored`, `holdout-spec-drift`,
   `holdout-clamp-rename-drift`) ≥ 14/15.
3. False positives ≤ 2 across all negatives; `go-harmless-variadic` pooled
   with the x10 run ≤ 2/13.
4. Critic-pruned must-find hits ≤ 4 (control 5).
5. Anchored recall ≥ 0.89; noise ≤ 0.05.
6. Cheat 0; invalid output ≤ 1.
7. `calibrate.ts accept`: no critic-attributed miss on a contract fixture.
   Other misses reported, not gating.

Pass → keep round 1 as the shipped critic. Fail → revert and record.

## Round 1 full gate result (2026-10-01)

Failed criterion 3: `go-harmless-variadic` false positive in 2 of 3 draws
(pooled with x10: 3/13, limit 2/13). All other criteria pass: tier-1 21/21,
contract 15/15, critic prunes 1, recall 0.931, noise 0.016, cheat 0,
invalid 0. Reverted to `d95aa170f3a37cf3`; data in `eval/RESULTS.md`.

## Gate rule change and round 1 adoption (2026-10-01, owner decision)

Decided after seeing the full-gate data, recorded as such. From now on, for
every Class R change: false positives are judged by the pooled count across
all negatives (≤ 2 per full x3 gate). A single contract-adjacent negative
is no longer a hard veto on its own. Rationale: the eval verifies 抓大放小.
Round 1 recovers a whole class of real defects (x10 49/50 vs 40/50; critic
prunes 1 vs 5). The cost is an occasional P2 on an unused parameter, which
is noise, not a missed bug.

Under this rule the round-1 full gate (2/84 FP, all other criteria pass)
passes without a rerun. Round 1 (`c59d803f0d0dc476`) is reapplied as the
shipped critic. The merged 273-draw report is scoring evidence only. It
cannot anchor `--baseline` or `calibrate.ts accept`. The next Class R full
gate provides the next anchor.
