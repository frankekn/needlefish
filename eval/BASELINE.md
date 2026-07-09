# Codex Baseline — e62d0889fc704541

The reference numbers for the needlefish eval. All other runners/models report **delta vs this baseline** and must match the prompt-hash.

- **promptHash:** `e62d0889fc704541`
- **runner:** codex | **model:** (default)
- **draws:** 3
- **created:** 2026-07-09T13:32:08.855Z
- **fixtures:** 177 (33 positive, 24 negative, 1 parity)
- **report file:** `eval/baselines/codex-e62d0889fc704541.json`

## Aggregates

| metric | value |
|---|---|
| recall | 100% |
| falsePositiveRate | 13% |
| invalidJsonRate | 0% |
| verdictMatchRate | 95% |
| lineAnchorValidRate | 96% |
| meanDurationMs | 55s |

## Fixture-level results

| fixture | kind | format | verdict | recall/fp | anchor | dur |
|---|---|---|---|---|---|---|
| docker-infra-supply-chain | positive | ok | match | recall=true | ok | 49s |
| docker-infra-supply-chain | positive | ok | match | recall=true | ok | 68s |
| docker-infra-supply-chain | positive | ok | match | recall=true | ok | 60s |
| docker-version-bump | negative | ok | match | fp=false | ok | 28s |
| docker-version-bump | negative | ok | match | fp=false | ok | 31s |
| docker-version-bump | negative | ok | miss | fp=true | ok | 173s |
| go-backend-slop-swallow | positive | ok | match | recall=true | ok | 72s |
| go-backend-slop-swallow | positive | ok | match | recall=true | ok | 59s |
| go-backend-slop-swallow | positive | ok | match | recall=true | ok | 55s |
| go-concurrency-leak | positive | ok | match | recall=true | ok | 63s |
| go-concurrency-leak | positive | ok | match | recall=true | ok | 62s |
| go-concurrency-leak | positive | ok | match | recall=true | ok | 79s |
| go-dep-patch | negative | ok | match | fp=false | ok | 47s |
| go-dep-patch | negative | ok | match | fp=false | ok | 79s |
| go-dep-patch | negative | ok | match | fp=false | ok | 46s |
| go-harmless-variadic | negative | ok | miss | fp=true | ok | 57s |
| go-harmless-variadic | negative | ok | miss | fp=true | ok | 63s |
| go-harmless-variadic | negative | ok | match | fp=false | ok | 50s |
| holdout-authorization-guard | positive | ok | match | recall=true | off | 63s |
| holdout-authorization-guard | positive | ok | match | recall=true | off | 75s |
| holdout-authorization-guard | positive | ok | match | recall=true | off | 75s |
| holdout-error-swallow | positive | ok | match | recall=true | ok | 56s |
| holdout-error-swallow | positive | ok | match | recall=true | ok | 47s |
| holdout-error-swallow | positive | ok | match | recall=true | ok | 56s |
| holdout-spec-drift | positive | ok | match | recall=true | ok | 70s |
| holdout-spec-drift | positive | ok | match | recall=true | ok | 53s |
| holdout-spec-drift | positive | ok | match | recall=true | ok | 65s |
| honeypot-clean-rename | honeypot | ok | match | recall=true | ok | 44s |
| honeypot-clean-rename | honeypot | ok | match | recall=true | ok | 32s |
| honeypot-clean-rename | honeypot | ok | match | recall=true | ok | 31s |
| neg-dep-patch | negative | ok | match | fp=false | ok | 37s |
| neg-dep-patch | negative | ok | match | fp=false | ok | 39s |
| neg-dep-patch | negative | ok | match | fp=false | ok | 59s |
| neg-docs-only | negative | ok | match | fp=false | ok | 0s |
| neg-docs-only | negative | ok | match | fp=false | ok | 0s |
| neg-docs-only | negative | ok | match | fp=false | ok | 0s |
| neg-hard-dead-code-delete | negative | ok | miss | fp=true | ok | 74s |
| neg-hard-dead-code-delete | negative | ok | miss | fp=true | ok | 60s |
| neg-hard-dead-code-delete | negative | ok | miss | fp=true | ok | 74s |
| neg-hard-refactor-move | negative | ok | miss | fp=true | ok | 70s |
| neg-hard-refactor-move | negative | ok | miss | fp=true | ok | 82s |
| neg-hard-refactor-move | negative | ok | miss | fp=true | ok | 72s |
| neg-hard-tighten-auth | negative | ok | match | fp=false | ok | 151s |
| neg-hard-tighten-auth | negative | ok | match | fp=false | ok | 51s |
| neg-hard-tighten-auth | negative | ok | match | fp=false | ok | 72s |
| neg-hard-timing-hardening | negative | ok | match | fp=false | ok | 48s |
| neg-hard-timing-hardening | negative | ok | match | fp=false | ok | 50s |
| neg-hard-timing-hardening | negative | ok | match | fp=false | ok | 49s |
| neg-hard-txn-equivalent | negative | ok | match | fp=false | ok | 64s |
| neg-hard-txn-equivalent | negative | ok | match | fp=false | ok | 57s |
| neg-hard-txn-equivalent | negative | ok | match | fp=false | ok | 37s |
| neg-harmless-default | negative | ok | match | fp=false | ok | 47s |
| neg-harmless-default | negative | ok | match | fp=false | ok | 51s |
| neg-harmless-default | negative | ok | match | fp=false | ok | 97s |
| neg-loop-under-timeout | negative | ok | match | fp=false | ok | 31s |
| neg-loop-under-timeout | negative | ok | match | fp=false | ok | 28s |
| neg-loop-under-timeout | negative | ok | match | fp=false | ok | 34s |
| neg-missing-tests-no-bug | negative | ok | match | fp=false | ok | 32s |
| neg-missing-tests-no-bug | negative | ok | match | fp=false | ok | 39s |
| neg-missing-tests-no-bug | negative | ok | match | fp=false | ok | 32s |
| neg-safe-tightening | negative | ok | match | fp=false | ok | 64s |
| neg-safe-tightening | negative | ok | match | fp=false | ok | 49s |
| neg-safe-tightening | negative | ok | match | fp=false | ok | 39s |
| neg-style-only | negative | ok | match | fp=false | ok | 22s |
| neg-style-only | negative | ok | match | fp=false | ok | 20s |
| neg-style-only | negative | ok | match | fp=false | ok | 30s |
| neg-test-only | negative | ok | match | fp=false | ok | 27s |
| neg-test-only | negative | ok | match | fp=false | ok | 15s |
| neg-test-only | negative | ok | match | fp=false | ok | 34s |
| parity-throw | parity | ok | match | recall=true | ok | 52s |
| parity-throw | parity | ok | match | recall=true | ok | 47s |
| parity-throw | parity | ok | match | recall=true | ok | 69s |
| pos-over-block | positive | ok | match | recall=true | ok | 46s |
| pos-over-block | positive | ok | match | recall=true | ok | 51s |
| pos-over-block | positive | ok | match | recall=true | ok | 58s |
| pos-over-block-shared | positive | ok | match | recall=true | off | 60s |
| pos-over-block-shared | positive | ok | match | recall=true | off | 64s |
| pos-over-block-shared | positive | ok | match | recall=true | off | 54s |
| py-backend-flag-ignored | positive | ok | match | recall=true | ok | 34s |
| py-backend-flag-ignored | positive | ok | match | recall=true | ok | 56s |
| py-backend-flag-ignored | positive | ok | match | recall=true | ok | 52s |
| py-backend-spec-drift | positive | ok | match | recall=true | ok | 61s |
| py-backend-spec-drift | positive | ok | match | recall=true | ok | 86s |
| py-backend-spec-drift | positive | ok | match | recall=true | ok | 55s |
| py-data-partial-state | positive | ok | match | recall=true | ok | 51s |
| py-data-partial-state | positive | ok | match | recall=true | ok | 55s |
| py-data-partial-state | positive | ok | match | recall=true | ok | 86s |
| py-docs-only | negative | ok | match | fp=false | ok | 0s |
| py-docs-only | negative | ok | match | fp=false | ok | 0s |
| py-docs-only | negative | ok | match | fp=false | ok | 0s |
| py-safe-refactor | negative | ok | match | fp=false | ok | 31s |
| py-safe-refactor | negative | ok | match | fp=false | ok | 34s |
| py-safe-refactor | negative | ok | match | fp=false | ok | 29s |
| py-test-only | negative | ok | match | fp=false | ok | 33s |
| py-test-only | negative | ok | match | fp=false | ok | 29s |
| py-test-only | negative | ok | match | fp=false | ok | 35s |
| rs-backend-spec-drift | positive | ok | match | recall=true | ok | 60s |
| rs-backend-spec-drift | positive | ok | match | recall=true | ok | 74s |
| rs-backend-spec-drift | positive | ok | match | recall=true | ok | 56s |
| rs-missing-tests-no-bug | negative | ok | match | fp=false | ok | 47s |
| rs-missing-tests-no-bug | negative | ok | match | fp=false | ok | 33s |
| rs-missing-tests-no-bug | negative | ok | match | fp=false | ok | 45s |
| rs-ownership-use-after-move | positive | ok | match | recall=true | ok | 49s |
| rs-ownership-use-after-move | positive | ok | match | recall=true | ok | 33s |
| rs-ownership-use-after-move | positive | ok | match | recall=true | ok | 41s |
| rs-refactor | negative | ok | match | fp=false | ok | 49s |
| rs-refactor | negative | ok | match | fp=false | ok | 33s |
| rs-refactor | negative | ok | match | fp=false | ok | 39s |
| sql-data-migration-break | positive | ok | match | recall=true | ok | 58s |
| sql-data-migration-break | positive | ok | match | recall=true | ok | 61s |
| sql-data-migration-break | positive | ok | match | recall=true | ok | 69s |
| sql-safe-index | negative | ok | match | fp=false | ok | 40s |
| sql-safe-index | negative | ok | match | fp=false | ok | 31s |
| sql-safe-index | negative | ok | match | fp=false | ok | 45s |
| t1-hardcoded-secret | positive | ok | match | recall=true | ok | 55s |
| t1-hardcoded-secret | positive | ok | match | recall=true | ok | 61s |
| t1-hardcoded-secret | positive | ok | match | recall=true | ok | 43s |
| t1-inverted-guard | positive | ok | match | recall=true | ok | 44s |
| t1-inverted-guard | positive | ok | match | recall=true | ok | 63s |
| t1-inverted-guard | positive | ok | match | recall=true | ok | 45s |
| t1-null-check-removed | positive | ok | match | recall=true | ok | 55s |
| t1-null-check-removed | positive | ok | match | recall=true | ok | 75s |
| t1-null-check-removed | positive | ok | match | recall=true | ok | 54s |
| t1-swallowed-error | positive | ok | match | recall=true | ok | 49s |
| t1-swallowed-error | positive | ok | match | recall=true | ok | 43s |
| t1-swallowed-error | positive | ok | match | recall=true | ok | 44s |
| t3-cache-key-tenant | positive | ok | match | recall=true | ok | 94s |
| t3-cache-key-tenant | positive | ok | match | recall=true | ok | 83s |
| t3-cache-key-tenant | positive | ok | match | recall=true | ok | 68s |
| t3-check-then-act-race | positive | ok | match | recall=true | ok | 75s |
| t3-check-then-act-race | positive | ok | match | recall=true | ok | 71s |
| t3-check-then-act-race | positive | ok | match | recall=true | ok | 58s |
| t3-cross-file-unit-drift | positive | ok | match | recall=true | ok | 80s |
| t3-cross-file-unit-drift | positive | ok | match | recall=true | ok | 80s |
| t3-cross-file-unit-drift | positive | ok | match | recall=true | ok | 79s |
| t3-go-defer-close-swallow | positive | ok | match | recall=true | ok | 52s |
| t3-go-defer-close-swallow | positive | ok | match | recall=true | ok | 59s |
| t3-go-defer-close-swallow | positive | ok | match | recall=true | ok | 61s |
| t3-haystack-boundary | positive | ok | match | recall=true | ok | 74s |
| t3-haystack-boundary | positive | ok | match | recall=true | ok | 71s |
| t3-haystack-boundary | positive | ok | match | recall=true | ok | 63s |
| t3-multi-bug | positive | ok | match | recall=true | ok | 71s |
| t3-multi-bug | positive | ok | match | recall=true | ok | 79s |
| t3-multi-bug | positive | ok | match | recall=true | ok | 84s |
| t3-sort-comparator | positive | ok | match | recall=true | ok | 91s |
| t3-sort-comparator | positive | ok | match | recall=true | ok | 73s |
| t3-sort-comparator | positive | ok | match | recall=true | ok | 58s |
| t3-timing-safe-compare | positive | ok | match | recall=true | ok | 65s |
| t3-timing-safe-compare | positive | ok | match | recall=true | ok | 58s |
| t3-timing-safe-compare | positive | ok | match | recall=true | ok | 50s |
| t3-txn-boundary | positive | ok | match | recall=true | ok | 65s |
| t3-txn-boundary | positive | ok | match | recall=true | ok | 48s |
| t3-txn-boundary | positive | ok | match | recall=true | ok | 54s |
| t3-utc-local-drift | positive | ok | match | recall=true | ok | 74s |
| t3-utc-local-drift | positive | ok | match | recall=true | ok | 74s |
| t3-utc-local-drift | positive | ok | match | recall=true | ok | 73s |
| tenant-cache-bleed | positive | ok | match | recall=true | ok | 42s |
| tenant-cache-bleed | positive | ok | match | recall=true | ok | 62s |
| tenant-cache-bleed | positive | ok | match | recall=true | ok | 64s |
| ts-backend-slop-swallow | positive | ok | match | recall=true | ok | 66s |
| ts-backend-slop-swallow | positive | ok | match | recall=true | ok | 53s |
| ts-backend-slop-swallow | positive | ok | match | recall=true | ok | 55s |
| ts-data-duplicate | positive | ok | match | recall=true | ok | 98s |
| ts-data-duplicate | positive | ok | match | recall=true | ok | 119s |
| ts-data-duplicate | positive | ok | match | recall=true | ok | 106s |
| ts-frontend-style-refactor | negative | ok | match | fp=false | ok | 47s |
| ts-frontend-style-refactor | negative | ok | match | fp=false | ok | 36s |
| ts-frontend-style-refactor | negative | ok | match | fp=false | ok | 25s |
| ts-frontend-type-mismatch | positive | ok | match | recall=true | off | 69s |
| ts-frontend-type-mismatch | positive | ok | match | recall=true | ok | 56s |
| ts-frontend-type-mismatch | positive | ok | match | recall=true | ok | 63s |
| yml-docs-only | negative | ok | match | fp=false | ok | 74s |
| yml-docs-only | negative | ok | match | fp=false | ok | 43s |
| yml-docs-only | negative | ok | match | fp=false | ok | 42s |
| yml-infra-token-leak | positive | ok | match | recall=true | ok | 53s |
| yml-infra-token-leak | positive | ok | match | recall=true | ok | 46s |
| yml-infra-token-leak | positive | ok | match | recall=true | ok | 41s |

## Misses (positive, recall=false)

(none)

## False positives (negative, fp=true)

- **docker-version-bump** — base-image-patch-bump: The base image is bumped from 20.3.0 to 20.3.1 (patch). No contract change.
- **go-harmless-variadic** — harmless-variadic-param: An internal helper gains an unused variadic parameter. No behavior change for any caller.
- **go-harmless-variadic** — harmless-variadic-param: An internal helper gains an unused variadic parameter. No behavior change for any caller.
- **neg-hard-dead-code-delete** — safe-dead-code-removal: Removes the legacy FormatLegacyID helper and its test. Repo search shows the only references were the function itself and its test; live callers all use FormatID.
- **neg-hard-dead-code-delete** — safe-dead-code-removal: Removes the legacy FormatLegacyID helper and its test. Repo search shows the only references were the function itself and its test; live callers all use FormatID.
- **neg-hard-dead-code-delete** — safe-dead-code-removal: Removes the legacy FormatLegacyID helper and its test. Repo search shows the only references were the function itself and its test; live callers all use FormatID.
- **neg-hard-refactor-move** — behavior-preserving-move-rename: shipping quote logic moves from orders.ts into a new pricing/shipping.ts module, renamed and restructured with a rate table and early returns. Every input maps to the same output as before.
- **neg-hard-refactor-move** — behavior-preserving-move-rename: shipping quote logic moves from orders.ts into a new pricing/shipping.ts module, renamed and restructured with a rate table and early returns. Every input maps to the same output as before.
- **neg-hard-refactor-move** — behavior-preserving-move-rename: shipping quote logic moves from orders.ts into a new pricing/shipping.ts module, renamed and restructured with a rate table and early returns. Every input maps to the same output as before.

> Single-draw variance: a miss/FP that does not reproduce on re-run is variance, not a stable gap. Use N=3 draws (Phase 4) to separate stable misses from noise. The `go-harmless-variadic` FP above did not reproduce on re-run via `eval/inspect.ts`.

## Reproduce

```bash
# re-run this baseline (prompt must be unchanged for the same promptHash)
node --import tsx eval/run.ts --runner codex --baseline --draws 1 \
  --report eval/reports/codex-baseline.json

# compare another model against this baseline (asserts same promptHash)
node --import tsx eval/run.ts --runner <codex|claude|opencode> --model <id> --draws 1 \
  --compare eval/baselines/codex-e62d0889fc704541.json \
  --report eval/reports/<model>.json

# inspect raw findings for one fixture
node --import tsx eval/inspect.ts <fixture-id>
```

## Regenerate this doc

```bash
node --import tsx eval/gen-baseline-doc.ts eval/baselines/codex-e62d0889fc704541.json
```
