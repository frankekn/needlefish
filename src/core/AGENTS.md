# CORE KNOWLEDGE BASE

## OVERVIEW

`src/core/` owns review orchestration and verdict derivation, not IO setup or GitHub posting.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Small review flow | `review.ts` | Full diff -> `review.md` -> `critic.md`. |
| Large review flow | `review.ts` | `map.md` -> per-hotspot `deep.md` -> merge -> `critic.md`. |
| Verdict mapping | `verdict.ts` | P0/P1/P2 blocks; blocking residual risks become `needs_human`; P3 does not block. |
| Regression coverage | `review.test.ts`, `verdict.test.ts` | Especially tail coverage and residual-risk preservation. |

## CONVENTIONS

- Keep prompt loading centralized through `loadPrompt`.
- Keep `review()` pure relative to posting/caching; adapters own side effects.
- Preserve the large-PR tail-coverage backstop: every changed file must get deep-reviewed.
- Preserve critic pruning as the final quality gate before `toReviewResult`.

## ANTI-PATTERNS

- Do not skip changed files because the map pass missed them.
- Do not drop blocking residual risks after critic pruning.
- Do not add target-repo-specific review heuristics here.
