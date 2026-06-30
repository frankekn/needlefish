# Eval Results — 10 models × 3 draws

All runs share promptHash `2d82256f1bb7da69`. Baseline = codex gpt-5.5 @ xhigh. recall = regex-matched planted-bug hit rate (lower bound on true recall).

## Aggregates (delta vs codex-xhigh baseline)

| model | @effort | recall | Δrecall | fp | invalidJson | mean dur | fail |
|---|---|---|---|---|---|---|---|
| claude-opus-47-xhigh | @xhigh | 76% | -5pp | 2% | 0% | 49s | 0 |
| claude-opus-48-xhigh | @xhigh | 64% | -17pp | 0% | 0% | 73s | 0 |
| codex-gpt55-high | @high | 74% | -7pp | 2% | 0% | 89s | 0 |
| codex-gpt55-medium | @medium | 76% | -5pp | 0% | 0% | 74s | 0 |
| codex-gpt55-xhigh | @xhigh | 81% | (baseline) | 0% | 0% | 89s | 0 |
| opencode-deepseek-max | @max | 67% | -14pp | 0% | 12% | 184s | 12 |
| opencode-glm52-max | @max | 60% | -21pp | 0% | 5% | 69s | 5 |
| opencode-grok-max | @max | 12% | -69pp | 0% | 56% | 42s | 57 |
| opencode-kimi-max | @max | 60% | -21pp | 5% | 21% | 188s | 21 |
| opencode-qwen-max | @max | 36% | -45pp | 0% | 44% | 150s | 45 |

## Recall by positive fixture (hit rate over 3 draws)

| fixture | claude-opus-47-xhigh | claude-opus-48-xhigh | codex-gpt55-high | codex-gpt55-medium | codex-gpt55-xhigh | opencode-deepseek-max | opencode-glm52-max | opencode-grok-max | opencode-kimi-max | opencode-qwen-max |
|---|---|---|---|---|---|---|---|---|---|---|
| docker-infra-supply-chain | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 |
| go-backend-slop-swallow | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| go-concurrency-leak | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 1/3 | 3/3 | 3/3 |
| pos-over-block | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/3 | 3/3 | 3/3 |
| py-backend-flag-ignored | 2/3 | 2/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/3 | 0/3 | 2/3 | 3/3 |
| py-backend-spec-drift | 0/3 | 0/3 | 0/3 | 1/3 | 1/3 | 1/3 | 0/3 | 0/3 | 0/3 | 0/3 |
| py-data-partial-state | 3/3 | 3/3 | 1/3 | 2/3 | 3/3 | 3/3 | 2/3 | 0/3 | 3/3 | 3/3 |
| rs-backend-spec-drift | 0/3 | 0/3 | 0/3 | 0/3 | 1/3 | 1/3 | 0/3 | 0/3 | 2/3 | 0/3 |
| rs-ownership-use-after-move | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 |
| sql-data-migration-break | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| ts-backend-slop-swallow | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 0/3 | 3/3 | 0/3 | 0/3 | 0/3 |
| ts-data-duplicate | 3/3 | 1/3 | 3/3 | 2/3 | 2/3 | 0/3 | 1/3 | 0/3 | 0/3 | 0/3 |
| ts-frontend-type-mismatch | 3/3 | 3/3 | 3/3 | 3/3 | 3/3 | 2/3 | 3/3 | 0/3 | 3/3 | 0/3 |
| yml-infra-token-leak | 3/3 | 0/3 | 3/3 | 3/3 | 3/3 | 3/3 | 1/3 | 0/3 | 3/3 | 0/3 |

## Stable misses (recall=false on all 3 draws) — by model

**claude-opus-47-xhigh** (3): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift
**claude-opus-48-xhigh** (4): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift, yml-infra-token-leak
**codex-gpt55-high** (3): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift
**codex-gpt55-medium** (2): go-backend-slop-swallow, rs-backend-spec-drift
**codex-gpt55-xhigh** (1): go-backend-slop-swallow
**opencode-deepseek-max** (3): go-backend-slop-swallow, ts-backend-slop-swallow, ts-data-duplicate
**opencode-glm52-max** (3): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift
**opencode-grok-max** (11): go-backend-slop-swallow, py-backend-flag-ignored, py-backend-spec-drift, py-data-partial-state, rs-backend-spec-drift, rs-ownership-use-after-move, sql-data-migration-break, ts-backend-slop-swallow, ts-data-duplicate, ts-frontend-type-mismatch, yml-infra-token-leak
**opencode-kimi-max** (5): go-backend-slop-swallow, py-backend-spec-drift, sql-data-migration-break, ts-backend-slop-swallow, ts-data-duplicate
**opencode-qwen-max** (9): go-backend-slop-swallow, py-backend-spec-drift, rs-backend-spec-drift, rs-ownership-use-after-move, sql-data-migration-break, ts-backend-slop-swallow, ts-data-duplicate, ts-frontend-type-mismatch, yml-infra-token-leak

## False positives (fp=true on any draw) — by model

**claude-opus-47-xhigh**: sql-safe-index
**codex-gpt55-high**: go-harmless-variadic
**opencode-kimi-max**: go-harmless-variadic, neg-safe-tightening

## Notes
- opencode @ max: high invalidJson = timeout/parse fail (4-min timeout + no-retry for qwen/grok; 10-min + 2x retry for glm52/deepseek/kimi). Not model quality — runner/variant reliability.
- recall is a regex lower bound; a model may have found the bug with different wording and still scored 0. Use `eval/inspect.ts <fixture-id>` to verify specific misses.
- codex medium (76%) ≈ high (74%) within 3-draw noise — reasoning effort is not monotonic in recall here.
