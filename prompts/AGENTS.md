# PROMPTS KNOWLEDGE BASE

## OVERVIEW

`prompts/` is executable review policy. Prompt text defines what the model may inspect, what counts as a finding, and the exact JSON shape core code expects.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Small PR review | `review.md` | Full diff is present in the context bundle. |
| Large PR surface map | `map.md` | No bug findings; only hotspots and cross-file edges. |
| Large PR deep pass | `deep.md` | One hotspot; requires concrete evidence entries. |
| Weak-finding pruning | `critic.md` | Deletes weak findings and corrects severity; never adds findings. |

## CONVENTIONS

- Preserve read-only inspection language: `rg`, `git diff`, `git show`, `sed`, `nl`; no edits.
- Preserve “ONLY review policy is bundle `agentsMd`”. This is a product contract, not wording preference.
- Return exactly one fenced JSON object. Core code extracts and normalizes it.
- Findings must cite changed lines. Cross-file claims need producer and consumer locations.
- Prefer zero findings over weak findings.

## ANTI-PATTERNS

- Do not add target-repo-specific nouns or examples.
- Do not expand prompt scope into style, architecture taste, or missing tests without a concrete bug path.
- Do not let the critic add new findings; it prunes only.
- Do not remove Trigger A / Trigger B evidence contracts without matching core/test changes.
