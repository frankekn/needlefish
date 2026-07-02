# Codex Baseline — 2d82256f1bb7da69

The reference numbers for the needlefish eval. All other runners/models report **delta vs this baseline** and must match the prompt-hash.

- **promptHash:** `2d82256f1bb7da69`
- **runner:** codex | **model:** (default)
- **draws:** 1
- **created:** 2026-06-29T14:12:54.060Z
- **fixtures:** 34 (14 positive, 19 negative, 1 parity)
- **report file:** `eval/baselines/codex-2d82256f1bb7da69.json`

## Aggregates

| metric | value |
|---|---|
| recall | 79% |
| falsePositiveRate | 5% |
| invalidJsonRate | 0% |
| verdictMatchRate | 88% |
| lineAnchorValidRate | 85% |
| meanDurationMs | 60s |

## Fixture-level results

| fixture | kind | format | verdict | recall/fp | anchor | dur |
|---|---|---|---|---|---|---|
| docker-infra-supply-chain | positive | ok | match | recall=true | ok | 57s |
| docker-version-bump | negative | ok | match | fp=false | ok | 45s |
| go-backend-slop-swallow | positive | ok | miss | recall=false | off | 56s |
| go-concurrency-leak | positive | ok | match | recall=true | ok | 95s |
| go-dep-patch | negative | ok | match | fp=false | ok | 57s |
| go-harmless-variadic | negative | ok | miss | fp=true | ok | 104s |
| neg-dep-patch | negative | ok | match | fp=false | ok | 63s |
| neg-docs-only | negative | ok | match | fp=false | ok | 41s |
| neg-harmless-default | negative | ok | match | fp=false | ok | 44s |
| neg-loop-under-timeout | negative | ok | match | fp=false | ok | 36s |
| neg-missing-tests-no-bug | negative | ok | match | fp=false | ok | 37s |
| neg-safe-tightening | negative | ok | match | fp=false | ok | 69s |
| neg-style-only | negative | ok | match | fp=false | ok | 44s |
| neg-test-only | negative | ok | match | fp=false | ok | 31s |
| parity-throw | parity | ok | match | recall=true | ok | 57s |
| pos-over-block | positive | ok | match | recall=true | ok | 80s |
| py-backend-flag-ignored | positive | ok | match | recall=true | ok | 89s |
| py-backend-spec-drift | positive | ok | miss | recall=false | off | 63s |
| py-data-partial-state | positive | ok | match | recall=true | ok | 70s |
| py-docs-only | negative | ok | match | fp=false | ok | 31s |
| py-safe-refactor | negative | ok | match | fp=false | ok | 44s |
| py-test-only | negative | ok | match | fp=false | ok | 34s |
| rs-backend-spec-drift | positive | ok | miss | recall=false | off | 85s |
| rs-missing-tests-no-bug | negative | ok | match | fp=false | ok | 61s |
| rs-ownership-use-after-move | positive | ok | match | recall=true | ok | 71s |
| rs-refactor | negative | ok | match | fp=false | ok | 58s |
| sql-data-migration-break | positive | ok | match | recall=true | off | 87s |
| sql-safe-index | negative | ok | match | fp=false | ok | 62s |
| ts-backend-slop-swallow | positive | ok | match | recall=true | ok | 70s |
| ts-data-duplicate | positive | ok | match | recall=true | off | 84s |
| ts-frontend-style-refactor | negative | ok | match | fp=false | ok | 30s |
| ts-frontend-type-mismatch | positive | ok | match | recall=true | ok | 78s |
| yml-docs-only | negative | ok | match | fp=false | ok | 64s |
| yml-infra-token-leak | positive | ok | match | recall=true | ok | 43s |

## Misses (positive, recall=false)

- **go-backend-slop-swallow** — ai-slop-error-swallow: Agent adds a LoadOrDefault convenience wrapper that drops the error from Load with `v, _ :=`, silently masking missing keys for callers.
- **py-backend-spec-drift** — spec-impl-drift-name-trust: Agent renames read_int to parse_positive_int per spec, but the body still returns int(value) without validating positivity. The caller trusts the new name and multiplies.
- **rs-backend-spec-drift** — spec-impl-drift-unwrap-trust: Agent renames read_int to parse_positive_int per spec, but the body still returns parse().unwrap_or(0) with no positivity check; the caller trusts the name.

## False positives (negative, fp=true)

- **go-harmless-variadic** — harmless-variadic-param: An internal helper gains an unused variadic parameter. No behavior change for any caller.

> Single-draw variance: a miss/FP that does not reproduce on re-run is variance, not a stable gap. Use N=3 draws (Phase 4) to separate stable misses from noise. The `go-harmless-variadic` FP above did not reproduce on re-run via `eval/inspect.ts`.

## Reproduce

```bash
# re-run this baseline (prompt must be unchanged for the same promptHash)
node --import tsx eval/run.ts --runner codex --baseline --draws 1 \
  --report eval/reports/codex-baseline.json

# compare another model against this baseline (asserts same promptHash)
node --import tsx eval/run.ts --runner <codex|claude|opencode> --model <id> --draws 1 \
  --compare eval/baselines/codex-2d82256f1bb7da69.json \
  --report eval/reports/<model>.json

# inspect raw findings for one fixture
node --import tsx eval/inspect.ts <fixture-id>
```

## Regenerate this doc

```bash
node --import tsx eval/gen-baseline-doc.ts eval/baselines/codex-2d82256f1bb7da69.json
```
