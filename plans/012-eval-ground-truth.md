# 012 — eval ground truth + scorer comparability + weekly deploy dispatch

Closes the remaining eval-integrity findings from the 2026-07-16 design
review: the gate recomputes arithmetic, not ground truth; comparability
ignores scorer code; and the weekly lane strands the deploy gate (issue #19).
Touches eval/ + scripts/ + workflows only — no src pipeline change, so no
model-eval gate; the gate here is unit tests plus demonstrated fail-closed
refusals.

## F1. Persist per-draw finding evidence in reports

Problem: `DrawResult` stores only score booleans. A buggy or fabricated
scorer emitting `recall: true, cheatDetected: false` per draw passes
`gate-verdict.mjs`, which can only re-add the same booleans.

Fix: each DrawResult additionally records
- `findings`: the final normalized findings, each as
  `{ severity, category, file, lineStart, lineEnd, title, whyItBreaks }`
  (full text — truncation would break pattern re-matching), and
- `matchEvidence`: for every mustFind spec, the spec's pattern string plus
  the index of the finding that satisfied it (or null for a miss).

Leak note (accepted tradeoff): finding text on holdout fixtures is
answer-adjacent, but reports live in the needlefish repo, which evaluated
runners can never read (sandbox clones the fixture repo only). Holdout
discipline for briefs/subagents is unchanged.

## F2. gate-verdict recomputes from evidence, not booleans

`scripts/gate-verdict.mjs` re-executes each recorded pattern (case-insensitive,
same `title + " " + whyItBreaks` haystack as score.ts) against the persisted
findings and fails on any draw where the claimed recall/miss disagrees with
the re-execution, or where evidence is missing on a report that claims the
current scorer generation. Bounded goal: the gate now verifies the scorer's
claims against stored ground truth; it still does not re-run models.

## F3. scorerHash comparability

Problem: compare/resume gate on promptHash + fixtureSetHash only; two reports
scored by different scorer code compare as equivalent, and resume reuses
draws across scorer changes.

Fix: `scorerHash` = sha256 over the scoring-relevant sources
(eval/shared/score.ts, eval/shared/robustness.ts, eval/shared/types.ts),
computed like promptHash. Stamped on every report. Fail-closed, mirroring the
anticheatVersion pattern: compare(), resumeSlots(), weekly-compare, and both
doc generators refuse/withhold when either side's scorerHash is absent or
mismatched. Existing reports lack the field → they are legacy on arrival;
never grandfathered.

## F4. weekly-eval dispatches deploy (issue #19)

Problem: weekly-eval pushes its report commit to main with GITHUB_TOKEN;
GitHub suppresses workflow triggers from such pushes, so deploy.yml never
runs, release.json falls behind main, and the next PR review fails the
release-mismatch gate until someone deploys manually.

Fix: after the push step succeeds, weekly-eval.yml explicitly runs
`gh workflow run deploy.yml` (workflow_dispatch) with the pushed SHA noted in
the step output. Failure of the dispatch step fails the job loudly (no silent
strand).

## Consequences

Reports produced before 012 lack scorerHash and finding evidence: compare,
resume, weekly regression, and the doc generators treat them as unguarded
legacy (refuse/withhold), same as the anticheat generation cut. The first
weekly run after 012 skips the week-over-week comparison with an explicit
note and self-heals the week after. The W7 formal baseline re-record should
happen after 012 lands so the durable baseline carries evidence + scorerHash.

## Sequencing

Four commits (F1, F2, F3, F4). Local gate green → independent non-author
review → PR → merge on clean bot review (standing authorization). Runs in
parallel with 010/011 — no file overlap with src/ batches.
