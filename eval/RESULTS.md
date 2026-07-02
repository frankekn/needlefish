# Eval Results — all runs

All runs share promptHash `2d82256f1bb7da69`. Baseline = codex gpt-5.5 @ xhigh. recall = regex-matched planted-bug hit rate (lower bound on true recall). ⚠️ = partial (draws < 102); its recall/fp are over a biased subset and not directly comparable.

## Aggregates (delta vs codex-xhigh baseline; full runs only)

| model | @effort | draws | recall | Δrecall | fp | invalidJson | mean dur | fail |
|---|---|---|---|---|---|---|---|---|
| claude-opus-47-xhigh | @xhigh | 102/102 | 76% | -5pp | 2% | 0% | 49s | 0 |
| claude-opus-48-xhigh | @xhigh | 102/102 | 64% | -17pp | 0% | 0% | 73s | 0 |
| codex-gpt55-high | @high | 102/102 | 74% | -7pp | 2% | 0% | 89s | 0 |
| codex-gpt55-medium | @medium | 102/102 | 76% | -5pp | 0% | 0% | 74s | 0 |
| codex-gpt55-xhigh | @xhigh | 102/102 | 81% | (baseline) | 0% | 0% | 89s | 0 |
| ⚠️ grok-build-0.1-direct | @? | 98/102 | 47% | — | 9% | 2% | 76s | 2 |
| ⚠️ grok-composer-2.5-fast | @? | 52/102 | 63% | — | 0% | 6% | 46s | 3 |
| opencode-deepseek-max | @max | 102/102 | 67% | -14pp | 0% | 12% | 184s | 12 |
| opencode-glm52-max | @max | 102/102 | 60% | -21pp | 0% | 5% | 69s | 5 |
| opencode-grok-max | @max | 102/102 | 12% | -69pp | 0% | 56% | 42s | 57 |
| opencode-kimi-max | @max | 102/102 | 60% | -21pp | 5% | 21% | 188s | 21 |
| opencode-qwen-max | @max | 102/102 | 36% | -45pp | 0% | 44% | 150s | 45 |

## Recall by positive fixture (hit rate over 3 draws)

| fixture | claude-opus-47-xhigh | claude-opus-48-xhigh | codex-gpt55-high | codex-gpt55-medium | codex-gpt55-xhigh | grok-build-0.1-direct | grok-composer-2.5-fast | opencode-deepseek-max | opencode-glm52-max | opencode-grok-max | opencode-kimi-max | opencode-qwen-max |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| docker-infra-supply-chain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| go-backend-slop-swallow | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 1/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| go-concurrency-leak | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 1/3 | 3/3 | 3/3 |
| pos-over-block | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 |
| py-backend-flag-ignored | 2/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 1/3 | 0/3 | 2/3 | 3/3 |
| py-backend-spec-drift | 0/3 | 0/3 | 0/3 | 1/3 | 1/3 | 0/3 | 0/1 | 1/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-data-partial-state | 3/3 | 3/3 | 1/3 | 2/3 | 3/3 | 1/3 | 0/0 | 3/3 | 2/3 | 0/3 | 3/3 | 3/3 |
| rs-backend-spec-drift | 0/3 | 0/3 | 0/3 | 0/3 | 1/3 | 0/3 | 0/0 | 1/3 | 0/3 | 0/3 | 2/3 | 0/3 |
| rs-ownership-use-after-move | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 0/0 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 |
| sql-data-migration-break | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/2 | 0/0 | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| ts-backend-slop-swallow | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 0/0 | 0/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| ts-data-duplicate | 3/3 | 1/3 | 3/3 | 2/3 | 2/3 | 2/3 | 0/0 | 0/3 | 1/3 | 0/3 | 0/3 | 0/3 |
| ts-frontend-type-mismatch | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/0 | 2/3 | 3/3 | 0/3 | 3/3 | 0/3 |
| yml-infra-token-leak | 3/3 | 0/3 | 3/3 | 3/3 | 3/3 | 1/3 | 0/0 | 3/3 | 1/3 | 0/3 | 3/3 | 0/3 |

## Stable misses (recall=false on all 3 draws) — by model

**claude-opus-47-xhigh** (3): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift
**claude-opus-48-xhigh** (4): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift, yml-infra-token-leak
**codex-gpt55-high** (3): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift
**codex-gpt55-medium** (2): go-backend-slop-swallow, rs-backend-spec-drift
**codex-gpt55-xhigh** (1): go-backend-slop-swallow
**grok-build-0.1-direct** (4): go-backend-slop-swallow, pos-over-block, py-backend-spec-drift, rs-backend-spec-drift
**grok-composer-2.5-fast** (1): py-backend-flag-ignored
**opencode-deepseek-max** (3): go-backend-slop-swallow, ts-backend-slop-swallow, ts-data-duplicate
**opencode-glm52-max** (3): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift
**opencode-grok-max** (11): go-backend-slop-swallow, py-backend-flag-ignored, py-backend-spec-drift, py-data-partial-state, rs-backend-spec-drift, rs-ownership-use-after-move, sql-data-migration-break, ts-backend-slop-swallow, ts-data-duplicate, ts-frontend-type-mismatch, yml-infra-token-leak
**opencode-kimi-max** (5): go-backend-slop-swallow, py-backend-spec-drift, sql-data-migration-break, ts-backend-slop-swallow, ts-data-duplicate
**opencode-qwen-max** (9): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift, rs-ownership-use-after-move, sql-data-migration-break, ts-backend-slop-swallow, ts-data-duplicate, ts-frontend-type-mismatch, yml-infra-token-leak

## False positives (fp=true on any draw) — by model

**claude-opus-47-xhigh**: sql-safe-index
**codex-gpt55-high**: go-harmless-variadic
**grok-build-0.1-direct**: go-harmless-variadic, rs-refactor, sql-safe-index
**opencode-kimi-max**: go-harmless-variadic, neg-safe-tightening

## Notes
- **Runner reliability confound (opencode @ max):** high invalidJson = timeout/parse fail from opencode's agentic loop, not model quality. Proven by grok-build-0.1: opencode agentic = 12% recall / 56% invalidJson; same model via direct single-shot (openai runner) = 47% recall / 2% invalidJson. opencode @ max numbers are runner-confounded — treat as lower bounds, not model quality.
- **Partials (⚠️):** grok-build-0.1-direct = 98/102 (4 draws lost to grok outage on sql-data-migration-break); grok-composer-2.5-fast = 52/102 (skipped mid-run, grok instability). Their recall/fp are over completed draws only.
- recall is a regex lower bound; a model may have found the bug with different wording and still scored 0. Use `eval/inspect.ts <fixture-id>` to verify specific misses.
- codex medium (76%) ≈ high (74%) within 3-draw noise — reasoning effort is not monotonic in recall here.
- claude opus-47 (76%) > opus-48 (64%) — newer opus regressed on this set.

## P5 raw-diff prompt gate (2026-07-02)

Prompt change: small-path diff moved out of the escaped JSON bundle into a raw
sentinel-delimited section. promptHash 2d82256f1bb7da69 → c3418e2c8fd4762c —
rows above are NOT comparable with runs at the new hash.

| arm | prompt | recall | fp | invalidJson | mean dur |
|---|---|---|---|---|---|
| A | escaped JSON (old) | 78.6% (11/14) | 0% | 0% | 137s |
| B | raw diff (new) | **85.7% (12/14)** | 0% | 0% | 146s |

codex gpt-5.5 @ xhigh, 34 fixtures x 1 draw, concurrency 4. Sole divergence:
rs-backend-spec-drift (A miss, B hit); confirm tier on B = 2/3 vs ~1/4
historical on the old prompt. Gate: non-inferior recall + no fp/json
regression → **shipped** (needlefish main a488292).

Reports: eval/results/gate-p5-armA.json, gate-p5-armB.json, confirm-p5-rs.json.

## Effort experiment: medium vs xhigh (2026-07-02, raw-diff prompt)

| effort | recall | fp | mean dur |
|---|---|---|---|
| xhigh | 85.7% | 0% | 146s |
| medium | **92.9%** | 5.3% → 0/3 on confirm | **44s** |

The single medium fp (docker-version-bump) did not reproduce across 3 confirm
draws; py-backend-spec-drift hit 2/3 at medium. Default effort flipped to
medium (needlefish ef397be).

## Gating-sweep A/B (2026-07-02) — REVERTED

Conditional TRIGGER-A sweep for predicate-shaped small diffs, over-block
fixtures x 5 draws @ medium: no sweep 10/10 recall, with sweep 10/10 recall
but +50% calls when triggered and mean 60s → 79s. The trigger regex also
missed predicate-body-only changes (function name in context lines). No
measured benefit → reverted. Over-block instability from FUTURE_TODO is
resolved by raw-diff prompt + medium effort.

Reports: eval/results/effort-medium.json, confirm-medium.json, sweep-armA.json, sweep-armB.json.

## P9 TRIGGER C/D gate (2026-07-02) — shipped

Added TRIGGER C (contract drift) + TRIGGER D (swallowed failure) to
review.md/deep.md with a critic carve-out for contract-drift findings.
promptHash changes again — rows above not comparable.

Final gate (36 fixtures incl 2 sealed holdouts, medium, 1 draw):
recall **94.1%**, fp 0, invalidJson 0, meanDur 47.9s. Confirm tiers:
py/rs-backend-spec-drift 3/3+3/3 (was ~1/4-2/3), holdout-spec-drift and
holdout-error-swallow hit on first exposure, py-data-partial-state and
py-backend-flag-ignored 3/3 after regression fixes.

Iteration notes (6 rounds, each diagnosed before editing):
1. Triggers alone: spec-drift found by review but pruned by critic
   ("naming-only") → critic exception added.
2. Zero-caller escapes: both C and D cleared on "no in-repo callers" →
   public-carrier clauses added.
3. Trigger-as-taxonomy: model began treating the trigger list as the
   complete bug taxonomy ("No Trigger A-D fired → pass"), regressing
   py-data-partial-state to 0/3 → explicit anti-taxonomy line fixed it.
4. Pendulum fp: public-carrier clause flagged a harmless unused variadic
   param (go-harmless-variadic 3/3 fp) → clause scoped to promises that
   affect the result/data a caller receives; residual fp 1/3 in isolated
   confirm, 0 in the final gate.

Known blind spot (unchanged, 4 wording layers attempted): an exported
error-swallowing wrapper with zero in-repo callers
(go-backend-slop-swallow, 0/5+ across all variants) — the model will not
flag dead public API as P2. Candidate future fix: dedicated fixture class
sweep at higher effort, or accept as documented limitation.

Reports: eval/results/p9-gate-v2.json, p9-confirm.json, p9-confirm5.json.
