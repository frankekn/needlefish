# Needlefish evaluation results

This document records what the evaluation program has established, what was
shipped, and why. The [full chronological record](RESULTS_HISTORY.md) preserves
the original experiment notes, per-fixture matrices, failed gates, and report
paths.

## Current decision

As of 2026-08-21, keep **Codex `gpt-5.6-terra` at high effort** as the
production baseline.

DeepSeek is the strongest recent challenger: it produced higher recall, no
false positives, no invalid JSON, and better anchors. It was also 67% slower,
and its aggregate result came from one full-set draw rather than three. That is
enough to justify a full confirmation run, but not enough to replace Terra.
The later OX Alpha probe did not change this decision: its raw opencode lane
was format-confounded, while a schema-tolerant semantic probe still trailed
the established challengers and missed tier-1 defects.

| Metric | Terra baseline | DeepSeek candidate |
| --- | ---: | ---: |
| Completed draws | 252/252 | 84/84 |
| Full-set repetitions | 3 | 1 |
| Recall | 87.4% | 89.7% |
| Tier-1 recall | 100% | 100% |
| False-positive rate | 5.6% | 0% |
| Invalid-JSON rate | 1.2% | 0% |
| Verdict match | 94.4% | 94.0% |
| Valid anchors | 88.1% | 92.9% |
| Mean duration | 56.8s | 94.7s |

These runs used prompt `e62d0889fc704541`, fixture set
`1968a9d2fabe2a56`, scorer `a424d3bb59a40443`, and anti-cheat v2.

DeepSeek's six divergent fixtures were confirmed separately over three draws:

| Fixture | Hits |
| --- | ---: |
| `rs-backend-spec-drift` | 3/3 |
| `real-pr1-bundle-basesha-mismatch` | 2/3 |
| `real-pr1-gh-cli-missing-repo-flag` | 1/3 |
| `real-pr1-lenient-candidate-parse` | 0/3 |
| `real-pr1-neutral-conclusion` | 1/3 |
| `real-pr4-hotspot-truncation` | 0/3 |

Reports: [DeepSeek full set](results/2026-07-31-opencode-deepseek-v4-flash-max-x1.json)
and [divergence confirmation](results/2026-07-31-opencode-deepseek-v4-flash-max-confirm-x3.json).

## How to read the numbers

- **Recall** is the share of planted defects found. A hit must match the
  expected pattern and anchor file in the same finding.
- **Tier-1 recall** covers defects that must never be missed. Any tier-1 miss
  disqualifies a production lane.
- **False-positive rate** is measured on known-clean fixtures.
- **Verdict match** compares the final deterministic verdict with the expected
  verdict.
- **Valid anchors** measures whether findings point to changed lines that can
  be acted on.
- **Noise** counts unrelated findings on positive fixtures.
- **x1** is directional. Model rankings require at least **x3**, because
  single-draw rankings repeatedly changed under confirmation.

Only runs with matching prompt, fixture-set, scorer, and anti-cheat hashes are
directly comparable. A runner and model form one lane; changing the runner can
change both output quality and reliability.

## Conclusions that survived repeated testing

1. **Real PR fixtures decide model selection.** Synthetic fixtures eventually
   saturated and produced a different ranking from defects mined from actual
   pull requests.
2. **More reasoning effort does not guarantee more recall.** Higher effort
   often reduced false positives while missing more real defects.
3. **Runner behavior matters.** The same model behaved differently through
   Codex, pi, Grok, and opencode. Runner failures must not be reported as model
   failures.
4. **Longer prompts often reduce recall.** Several trigger additions and prompt
   packs suppressed finding generation instead of improving it.
5. **The critic can erase correct findings.** This caused the original
   `go-backend-slop-swallow` miss and part of the
   `bundle-basesha-mismatch` failure mode.
6. **Security and isolation remain hard gates.** Anti-cheat canaries never
   appeared in findings, while Grok's useful lane still requires accepting an
   unsandboxed runner.

## Experiment record

### 1. Prompt and critic foundation — 2026-07-02 to 2026-07-04

| Experiment | Result | Decision |
| --- | --- | --- |
| Raw diff instead of escaped JSON | Recall 78.6% → 85.7%; no FP or JSON regression | Shipped |
| Medium vs xhigh effort | Recall 92.9% vs 85.7%; 44s vs 146s | Switched default to medium |
| Conditional Trigger-A sweep | Same recall, 50% more calls, 60s → 79s | Reverted |
| Trigger C/D prompt gate | Recall 94.1%, FP 0, invalid JSON 0 | Shipped |
| GitHub suggestion blocks | Recall 94.4%, FP 0, invalid JSON 0, 49.7s | Shipped |
| High-effort retry for public error swallowing | Target remained 0/3 | Reverted |
| Critic error-propagation exception | Recall 94.7%; prune errors 5.56% → 0 | Shipped |

The important diagnosis was that `go-backend-slop-swallow` was detected by the
review pass and then deleted by the critic. The W4 change narrowly protected
discarded errors in exported APIs while tightening a broader contract-drift
rule that had created false positives. Confirmation moved the target from 0/3
to 3/3 and kept the relevant negative fixtures clean.

Key reports: [P5 arm A](results/gate-p5-armA.json),
[P5 arm B](results/gate-p5-armB.json), [P9 gate](results/p9-gate-v2.json),
[W2 gate](reports/w2-gate.json), and [W4 gate](reports/w4-final-gate.json).

### 2. Stronger scorer and early model comparisons — 2026-07-09

The scorer added anchored recall, difficulty tiers, noise, honeypot canaries,
and fixture-set guards. This created a new 51-fixture baseline; older numbers
were no longer comparable.

| Lane | Recall | FP | Invalid JSON | Mean draw |
| --- | ---: | ---: | ---: | ---: |
| Codex gpt-5.5 medium | 100% | 12% | 0% | 55s |
| Claude Opus 4.8 xhigh | 93% | 0% | 0% | 115s |
| opencode GLM 5.2 max | 93% | 0% | 1% | 197s |
| Grok 4.5 initial lane | 24% | 0% | 67% | 60s |
| Grok 4.5 unsandboxed | 95% | 0% | 0% | 53s |

Grok's first result was a runner-contract failure: plan mode emitted narration
instead of JSON. Removing that mode restored quality, but also removed an
effective write restraint. Grok therefore became a strong challenger, not an
automatic production choice.

Eight harder synthetic fixtures increased the set to 59. Frontier models
still saturated the positive set, while mirror-trap negatives exposed useful
precision differences. This ended further synthetic-only difficulty rounds;
new difficulty would come from real misses.

### 3. Harness and GPT-5.6 comparisons — 2026-07-09 to 2026-07-10

Through the pi harness, Opus 4.8 kept the same 92.9% recall as its Claude CLI
lane and ran about three times faster, with a 2.3% invalid-JSON cost. On the
same pi harness, Sonnet 5 was the best quality/cost result: 99% recall, 0% FP,
and 44s per draw.

The first Codex-lane GPT-5.6 synthetic comparison favored Luna:

| Model | Recall | FP | Invalid JSON | Mean draw |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.5 medium | 100% | 12.5% | 0% | 55s |
| gpt-5.6-luna | 99.0% | 8.3% | 0.6% | 54s |
| gpt-5.6-sol | 93.9% | 13.9% | 0% | 48s |
| gpt-5.6-terra | 91.9% | 5.6% | 1.7% | 139s |

That ranking reversed on 21 fixtures mined from real Needlefish PRs:

| Model | Real-PR recall | Tier 1/2/3 | Noise |
| --- | ---: | --- | ---: |
| gpt-5.6-sol | 81.0% | 100/94/52 | 0.08 |
| gpt-5.5 | 71.4% | 78/91/38 | 0.11 |
| gpt-5.6-luna | 65.1% | 78/82/33 | 0.19 |

This rank inversion established the current policy: production selection must
follow real-PR results, not synthetic headline recall.

The same Sol model also performed more cleanly through Codex than pi: 85.2%
vs 84.4% recall, 0% vs 10.6% FP, and 100% vs 93.2% verdict match. Production
returned to the Codex runner; pi remained a fallback.

Prompt additions did not rescue the hard real misses. Trigger E reduced Codex
recall from 92.6% to 88.1%. A pi-specific discipline section improved recall
from 86.7% to 91.1%, but left FP at 13.6% and was not adopted for the fallback
lane. Terra and Luna at xhigh reduced FP but also reduced recall, so production
stayed on Sol medium at that point.

### 4. Self-check and critic investigation — 2026-07-11 to 2026-07-12

Tracing showed that `bundle-basesha-mismatch` had two causes: generation often
failed to produce a candidate, and the critic sometimes deleted a correct
candidate. Seven controlled rounds separated those causes.

| Round | Test | Result | Decision |
| --- | --- | --- | --- |
| 3 | Critic exception on the real miss | Candidate generation remained about 1/5; target 0/3 | Reverted |
| 4 | Three synthetic critic-isolation fixtures | 9/9 passed before any change | Exception not justified |
| 5 | Extra post-generation self-check | Targets improved only to 0–1/3; mean 89s exceeded 75s cap | Not shipped |
| 6 | Exception measured with end-to-end recall | Prunes fell to 0/3, but recall was only 1/3 | Reverted |
| 7 | Seam-isolated x9 test | Candidate present 3/9; critic still pruned 2/3 | Abandoned |

The campaign stopped because neither prompt wording nor the extra model call
met its pre-declared gate. The next useful lever is structural measurement:
score individual `mustFind` items so partial progress on multi-defect fixtures
is visible.

After four guard fixtures were added, the 84-fixture Sol baseline was 93.1%
recall, 12.5% FP, 95.2% verdict match, and zero tier-1 misses. Its four misses
were the already-known real tier-3 cases.

### 5. Five-lane x3 matrix and anti-cheat validation — 2026-07-12 to 2026-07-13

| Lane | Recall | FP | Invalid JSON | Verdict match | Mean draw |
| --- | ---: | ---: | ---: | ---: | ---: |
| gpt-5.5 medium | 90.8% | 9.7% | 0% | 95.2% | 58s |
| gpt-5.6-sol medium | 89.7% | 6.9% | 0% | 95.6% | 53s |
| Grok 4.5 xhigh | 88.5% | 0% | 0% | 95.6% | 50s |
| gpt-5.6-luna max | 88.5% | 9.7% | 0.4% | 95.2% | 134s |
| Opus 4.8 xhigh via pi | 86.2% | 0% | 2.8% | 90.1% | 53s |

The x3 run reversed the earlier x1 ordering between Grok and Opus, confirming
that x1 is not enough for rankings. GPT-family lanes shared a stable false
positive on behavior-preserving refactors. Grok removed that FP at a 1.2-point
recall cost versus Sol, but still required unsandboxed execution.

A Phase-1 coverage-plumbing branch stayed within sampling noise on both Sol
and Grok and was cleared to ship. The anti-cheat rerun used ephemeral homes and
a per-run canary; `cheatDetectedCount` remained zero, quality stayed within x3
noise, and the guards added no measurable latency.

Reports: [Grok x3](reports/2026-07-12-grok45-xhigh-x3.json),
[Opus x3](reports/2026-07-12-pi-opus48-xhigh-x3.json),
[Sol x3](reports/2026-07-12-sol-medium-x3.json), and
[anti-cheat validation](reports/2026-07-13-anticheat-grok45-x3.json).

### 6. Terra prompt program — 2026-07-18 to 2026-07-19

Terra high became production in PR #29. Four prompt experiments then tested
whether shorter or stricter wording could improve it.

| Experiment | Result | Decision |
| --- | --- | --- |
| Lean prompt | Helped Sol, but reduced Terra real-PR recall | Not shipped |
| Issue-sweep batch gate | Terra baseline: .874 recall, .069 FP, .075 noise | Shipped code; kept prompt |
| Eight-change quality pack | Recall fell to .753 and .764 in paired rounds | Not shipped |
| A5-only evidence rule | Tier-1 swallowed-error recall fell 1.00 → .33 | Not shipped |

The original lean-prompt rejection initially blamed a fivefold FP increase.
Same-day reruns showed that Terra's FP rate itself drifted by provider window.
A same-window paired test corrected the diagnosis: FP tied, while the lean
prompt still lost real-PR recall. Future Terra prompt comparisons therefore
must run paired in the same window.

Across six controlled comparisons, added wording consistently taxed recall.
The prompt-edit program closed with `e62d0889` as the measured optimum for this
lane. Remaining gains require structural changes rather than more prose.

### 7. Precision challengers — 2026-07-26 to 2026-07-31

Qwen 3.8 Max Preview completed 252 guarded draws with 85.6% recall, 0% FP, 0%
invalid JSON, 91.3% verdict match, and 80.3s mean duration. It failed the
production gate because `real-pr1-self-review-tool-checkout` hit only 2/3; any
tier-1 miss is disqualifying. Qwen remains a precision-oriented second-opinion
candidate. [Report](reports/2026-07-26-qwen38-max-preview-xhigh-x3.json).

DeepSeek then produced the stronger directional result shown at the top of
this page. Its next gate is straightforward: run the full guarded fixture set
x3 under the same hashes, then compare divergent fixtures and latency against
Terra before considering promotion.

### 8. OX Alpha runner and semantic probe — 2026-08-21

The `openrouter/stealth/ox-alpha` opencode run was stopped after 176/252 draws.
It had 23.5% recall and 51.7% invalid output, so it is a biased partial and does
not measure the model independently of its runner contract.

The 26 fixtures not completed by that run were then tested x3 through a
temporary schema-tolerant OpenAI-compatible adapter. The adapter normalized
only the review envelope: it retained findings only when the model supplied a
file, positive line anchor, title, and failure explanation. It did not invent
bugs or anchors.

| Metric | OX Alpha semantic probe |
| --- | ---: |
| Completed draws | 78/78 |
| Recall | 51.4% |
| Must-find hit rate | 52.3% |
| Must-find hit rate on usable positive draws | 66.1% |
| Tier-1 / tier-2 / tier-3 recall | 77.8% / 50.0% / 42.9% |
| Unusable-output rate | 21.8% |
| False-positive rate | 0% |
| Mean duration | 334.5s |
| Noise per positive | 0.014 |

The probe shows genuine review ability behind the schema failures, especially
on diff-base, token-corruption, field-coercion, max-buffer, token-leak, and
untrusted-runner defects. It also shows semantic misses beyond formatting:
fallback commit pinning, lenient candidate parsing, neutral conclusions,
severity downgrade, hotspot truncation, and option forwarding remained weak.
The critic pruned five correct candidates. OX Alpha is not qualified for the
production lane at this configuration; the semantic probe is diagnostic and
is not directly comparable with a production gate because it used a subset
fixture hash and a temporary adapter.

Reports: [partial opencode run](results/2026-08-21-opencode-ox-alpha-max-x3.json)
and [semantic probe](results/2026-08-21-ox-alpha-semantic-remaining-x3.json).

### 9. Residual fail-soft structural gate — pre-declared 2026-08-24

Change under test: critic residuals that cannot be restored exactly from the
candidate bag (including a non-blocking-to-blocking upgrade) are pruned rather
than aborting the entire review. Finding invention remains fail-closed. This is
a structural pipeline change; prompts and scorer are unchanged.

Production lane: Codex / `gpt-5.6-terra` / high, full fixture set, holdouts
included, three draws. Pass criteria declared before seeing the report:

1. Zero errors containing `residual risk was not in the candidate review` or
   `residual risk is blocking but was not blocking in the candidate review`.
2. `recallByTier.t1 === 1`; any tier-1 miss fails the gate.
3. Overall recall >= 0.84, false-positive rate <= 0.10, and
   `meanNoisePerPositive <= 0.12` (the measured production envelope of the two
   2026-08-23/24 full Terra x3 gates).
4. `real-pr4-options-not-forwarded` recall >= 2/3; this is the retained fixture
   that previously produced the residual subset rejection.
5. `cheatDetectedCount === 0`. Any cheat detection voids the report.

Gate failure means revert this pipeline change and retain the report here.

**Result: FAILED (4/5 criteria), reverted.** The full 85-fixture / 255-draw
report completed with prompt hash `e62d0889fc704541`, fixture hash
`7fa7d2fdb1586db9`, scorer hash `bd85218ae8ae948f`, and anti-cheat v2.

| Criterion | Result |
| --- | --- |
| Residual subset errors | PASS — 0/255 |
| Tier-1 recall | **FAIL — 0.8571** (`t1-inverted-guard` 2/3; `real-pr1-self-review-tool-checkout` 1/3) |
| Recall / FP / noise envelope | PASS — 0.8475 / 0.0417 / 0.0904 |
| `real-pr4-options-not-forwarded` | PASS — 3/3 |
| Cheat detection | PASS — 0 |

Four unrelated critic-envelope failures remained (`critic produced no summary
or checked list`): one `go-harmless-variadic`, one
`neg-hard-refactor-move`, and two `neg-safe-tightening` draws. The residual
fail-soft behavior removed the targeted failure and did not cause the tier-1
misses, but the pre-declared production rule treats any tier-1 miss as
disqualifying; no post-hoc exception was made. Report:
[`results/2026-08-24-residual-failsoft-gate-x3.json`](results/2026-08-24-residual-failsoft-gate-x3.json).

### 10. Residual conservative-fallback structural gate — pre-declared 2026-08-24

Second design under test after reverting the failed fail-soft gate: exact
critic residual subsets still prune normally, but any unmatched, exhausted, or
blocking-upgraded residual makes Needlefish retain the complete candidate
residual list. Large-path blocking residual re-append is de-duplicated. This
keeps missing-evidence signals conservative while preventing critic wording
drift or invention from aborting a review or changing its verdict.

Production lane and pre-declared pass criteria are unchanged: full fixture set,
holdouts included, Codex / `gpt-5.6-terra` / high, three draws; zero residual
subset errors; tier-1 recall exactly 1; overall recall >= 0.84, FP <= 0.10,
noise <= 0.12; `real-pr4-options-not-forwarded` recall >= 2/3; and zero cheat
detections. Any miss fails and reverts this second design. Report target:
`results/2026-08-24-residual-conservative-fallback-gate-x3.json`.

**Result: FAILED (4/5 criteria), reverted.** All 255 draws completed with zero
format errors, zero targeted residual subset errors, 0.8870 recall, 0.0694 FP,
0.0621 noise, zero cheat detections, and
`real-pr4-options-not-forwarded` at 2/3. Tier-1 recall was **0.9048**:
`t1-inverted-guard` missed draw 2 and
`real-pr1-self-review-tool-checkout` missed draw 3. Both were usable model
outputs rather than residual matching failures, but the pre-declared rule
allows no tier-1 exception. Report:
[`results/2026-08-24-residual-conservative-fallback-gate-x3.json`](results/2026-08-24-residual-conservative-fallback-gate-x3.json).

### 11. Structured-facts + conservative residual fallback gate — pre-declared 2026-08-24

Change under test: independently curated, same-finding structured-fact scoring
for the two tier-1 fixtures whose sentence regexes rejected valid paraphrases;
plus the conservative residual fallback from gate 10. Finding invention remains
fail-closed. Any unmatched, exhausted, or blocking-upgraded critic residual
restores the complete candidate residual list; exact subsets still prune, and
the large-path blocking backstop preserves multiset cardinality without
duplicating retained residuals.

Oracle curation was isolated from model transcripts and received only each
fixture's description, base/head files, and anchor. Two phrase-regex schemas
failed frozen historical preflight (0/12 and 4/12) and were discarded without
transcript-driven edits. The final representation matches independently
curated regex atoms as unordered conjunctions. A production-lane confirm on
only `t1-inverted-guard` and `real-pr1-self-review-tool-checkout` passed 6/6
with tier-1 recall 1, scorer hash `389cd43533bb1ddd`, and zero cheat detections.
Report:
[`results/2026-08-24-structured-facts-confirm-x3.json`](results/2026-08-24-structured-facts-confirm-x3.json).

Final production lane: Codex / `gpt-5.6-terra` / high, all 86 fixtures,
holdouts included, three draws. The new
`holdout-pagination-round-down` fixture was sealed before this run and was not
used during iteration. Pass criteria declared before seeing the report:

1. Zero errors containing `residual risk was not in the candidate review` or
   `residual risk is blocking but was not blocking in the candidate review`.
2. `recallByTier.t1 === 1`; any tier-1 miss fails the gate.
3. Overall recall >= 0.84, false-positive rate <= 0.10, and
   `meanNoisePerPositive <= 0.12`.
4. `real-pr4-options-not-forwarded` recall >= 2/3.
5. `holdout-pagination-round-down` recall >= 2/3.
6. `cheatDetectedCount === 0`; any cheat detection voids the report.

Gate failure means revert the residual pipeline change and preserve the full
report. No criterion may be relaxed after results are visible.

**Result: ABORTED and FAILED.** The run was stopped after 163/258 draws when a
production-infra concern was raised; it is structurally incomplete and cannot
serve as a gate report. Criterion 2 had already failed in the completed prefix:
automatic tier-1 recall was 0.8333 and `t1-inverted-guard` scored 1/3. A fresh,
isolated adjudicator then evaluated the two misses against only the fixture,
frozen fact meanings, anchor, and findings; both contained both required facts
in one anchored finding (`isAdmin=true` returned forbidden and
`isAdmin=false` reached `db.delete`). This establishes a lexical-adapter miss,
not a reviewer miss, but the pre-declared gate permits no post-hoc exception.
Partial report:
[`results/2026-08-24-structured-residual-final-gate-x3.json`](results/2026-08-24-structured-residual-final-gate-x3.json).

### 12. Semantic structured-facts fallback gate — pre-declared 2026-08-24

The fixture facts, anchors, production pipeline change, model, effort, and all
six numeric/safety criteria from gate 11 are unchanged. A new transcript-blind
completeness curator inspected only the descriptions, diffs, and frozen facts
and added direct source-expression alternatives; it did not see findings or
scores. Because finite regex alternatives still cannot be a semantic oracle,
the scoring procedure is pre-declared as follows:

- The versioned deterministic matcher runs first.
- Only a structured-fact miss is sent to an isolated Codex /
  `gpt-5.6-sol` / high adjudicator with the fixture description, base/head
  files, anchor, frozen fact meanings, and that draw's findings.
- It may not combine findings or alter facts. A miss becomes a hit only when
  three independent adjudications unanimously identify the same anchored
  finding as containing every frozen fact. Any disagreement remains a miss.
- Adjudication inputs/results and their hashes are retained beside the report.

Final lane remains Codex / `gpt-5.6-terra` / high, all 86 fixtures, holdouts
included, three draws. Pass criteria remain: zero targeted residual-subset
errors; semantic tier-1 recall exactly 1; overall recall >= 0.84, FP <= 0.10,
noise <= 0.12; `real-pr4-options-not-forwarded` >= 2/3; sealed pagination
holdout >= 2/3; and zero cheat detections. No result from gate 11 is reused.

**Result: OPERATIONALLY FAILED.** All 258 slots were written, but 103 draws
failed with `codex runner exited 1` after the account exhausted its usage
limit, plus one unrelated malformed critic output. The resulting 0.4031
invalid-output rate makes every quality aggregate unusable. No targeted
residual-subset error occurred, but the report cannot establish the gate.
Report:
[`results/2026-08-24-semantic-fallback-gate-x3.json`](results/2026-08-24-semantic-fallback-gate-x3.json).

### 13. Replenished-capacity retry — pre-declared 2026-08-25

The gate-12 contract, frozen 86-fixture set, hashes, lane, and criteria were
unchanged. No draw from gate 12 was reused. This attempt was intentionally
stopped after a new confirmed real-PR miss changed the planned subsequent
pipeline work; spending the remaining shared quota could not authorize that
future change. The partial completed 106/258 draws with one unrelated invented
critic finding error. It is archived and not used as evidence. Report:
[`results/2026-08-25-semantic-fallback-final-gate-x3.json`](results/2026-08-25-semantic-fallback-final-gate-x3.json).

### 14. Residual-only final gate — pre-declared 2026-08-25

This is the final gate for only the conservative residual-subset fallback and
the independently curated structured-fact scorer already described above.
The fixture set remains frozen at 86; the two newly confirmed endpoint-
identity misses are sealed separately for the later invariant-enforcement
change and are neither executed nor used to tune this residual-only change.
No prior draw is reused.

Lane: Codex / `gpt-5.6-terra` / high, holdouts included, three draws,
concurrency 1. Hashes must remain prompt `e62d0889fc704541`, scorer
`389cd43533bb1ddd`, fixture set `e4969c9fdc2e3497`.

Pass criteria are unchanged: zero targeted residual-subset errors; semantic
tier-1 recall exactly 1 using the unanimous three-adjudicator fallback only
for structured-fact lexical misses; overall recall >= 0.84, FP <= 0.10, noise
<= 0.12; `real-pr4-options-not-forwarded` >= 2/3; sealed pagination holdout
>= 2/3; and zero cheat detections. Any incomplete report, usage-limit failure,
or criterion miss fails the gate and blocks deployment.

**Result: FAILED (5/6 criteria).** All 258/258 draws completed under the
declared hashes (prompt `e62d0889fc704541`, scorer `389cd43533bb1ddd`,
fixture set `e4969c9fdc2e3497`, anticheat v2).

| Criterion | Result |
| --- | --- |
| Zero targeted residual-subset errors | PASS — 0/258 (the change's own target) |
| Semantic tier-1 recall exactly 1 | **FAIL — 20/21.** `t1-inverted-guard` draw 0 flipped to hit on unanimous 3-adjudicator semantic scoring; draw 2 unanimously confirmed a miss (fact `non_admins_can_purge` absent from the single finding). Artifacts + sha256 manifest: [`results/gate13-adjudication/`](results/gate13-adjudication/) |
| Recall >= 0.84, FP <= 0.10, noise <= 0.12 | PASS — 0.8667 / 0.0556 / 0.0833 |
| `real-pr4-options-not-forwarded` >= 2/3 | PASS — 2/3 |
| Sealed pagination holdout >= 2/3 | PASS — 3/3 |
| Cheat detections = 0 | PASS — 0 |

Per the pre-declared rule this fails the gate and blocks deployment of the
residual-subset fallback from this lane.

Orthogonality note for the record: the automatic tier-1 misses are invariant
across residual-pipeline variants and therefore not attributable to the change
under test — `t1-inverted-guard` scored 2/3 under gate 9 (fail-soft prune),
2/3 under gate 10 (conservative fallback), and 1/3 here, with the finding path
byte-identical between variants. The tier-2/3 misses (`real-pr1-bundle-basesha-mismatch`
0/3 in all three full gates, `real-pr1-diff-base-tip-not-mergebase` 2/3 →
3/3 → 2/3) never touched any pass criterion: overall recall stayed inside the
pre-declared envelope in every variant. These are stable model/fixture
properties tracked separately, not delivery-layer regressions.

### 15. Residual fail-soft restore re-declared as Class D — pre-declared 2026-08-25

Same working-tree change as gate 14 (conservative residual-subset fallback;
finding matching untouched), now classified explicitly under the gate-class
taxonomy added to AGENTS.md EVAL DISCIPLINE today. Classification is provenance
containment, not motive: on every input where the old pipeline completed, the
new pipeline produces identical output; on inputs where it aborted with a
targeted residual error, the new output is the candidate bag already admitted
by the deep pass. Gate 14's own artifacts are empirical evidence of containment
(0 targeted errors over 258 draws), but per discipline no criterion may be
relaxed after results are visible, so gate 14 stands as failed and this fresh,
cheaper D-contract gate authorizes shipping instead.

D-gate contract (all pre-declared):

1. Resident property suite green: `src/core/residual-provenance.test.ts`
   (drift corpus must survive inside the candidate bag; identity breaks must
   still reject). Already passing at declaration time: 14/14.
2. Drift-subset x3 on Codex / `gpt-5.6-terra` / high: fixtures
   `real-pr4-options-not-forwarded`, `t3-cache-key-tenant`,
   `honeypot-clean-rename`. Pass = zero targeted residual-subset errors, zero
   malformed-critic errors of any class, zero cheat detections.
3. Live canary window after deploy with automatic rollback to the
   last-known-good install if the infra-error rate exceeds its threshold.

The change stays confined to the working tree — excluded from any release —
until criterion 2 passes. A failed D gate means revert outright.

**Result: PASSED (3/3 criteria).** Report:
[`results/2026-08-25-residual-d-gate-x3.json`](results/2026-08-25-residual-d-gate-x3.json)
(`gateClass: "D"`, prompt hash `e62d0889fc704541` matching the declared lane).

| Criterion | Result |
| --- | --- |
| Property suite (`residual-provenance.test.ts`) | PASS — 14/14 |
| Drift-subset x3: zero targeted residual-subset errors, zero malformed-critic errors, zero cheat | PASS — 9/9 draws, 0 errors, 0 cheat; `recallByFixture` 1.0 on all three fixtures |

Authorized to ship behind the canary window (criterion 3). The residual
fail-soft restore may now be released; rollback trigger stays armed for the
declared window.

## Legacy pre-guard benchmark

These early runs used prompt `2d82256f1bb7da69` and a weaker regex-only
scorer. They are retained for historical context, not comparison with current
runs.

| Lane | Recall | FP | Invalid JSON | Mean draw |
| --- | ---: | ---: | ---: | ---: |
| Codex gpt-5.5 xhigh | 81% | 0% | 0% | 89s |
| Claude Opus 4.7 xhigh | 76% | 2% | 0% | 49s |
| Codex gpt-5.5 medium | 76% | 0% | 0% | 74s |
| Codex gpt-5.5 high | 74% | 2% | 0% | 89s |
| opencode DeepSeek max | 67% | 0% | 12% | 184s |
| Claude Opus 4.8 xhigh | 64% | 0% | 0% | 73s |
| opencode GLM 5.2 max | 60% | 0% | 5% | 69s |
| opencode Kimi max | 60% | 5% | 21% | 188s |
| Grok build 0.1 direct* | 47% | 9% | 2% | 76s |
| opencode Qwen max | 36% | 0% | 44% | 150s |
| opencode Grok max | 12% | 0% | 56% | 42s |

\*Partial run: 98/102 draws. The Grok Composer partial completed only 52/102
draws and is omitted from this summary table because its subset was biased.
The full matrix, stable misses, false positives, and reliability notes remain
in [the historical record](RESULTS_HISTORY.md).

### 16. Fixture audit opened: `real-pr1-bundle-basesha-mismatch` — 2026-08-25

Facts: 0/9 draws across gates 9, 10, and 14 (three different residual-pipeline
variants; finding path byte-identical between them). Tier 3, so it bounds only
overall recall margin, which stayed inside the pre-declared envelope in all
three gates. Provenance is per protocol: mustFind patterns come from the
human reviewer's own wording in the source PR thread (README step 4), not
reverse-engineered.

Working hypothesis for the stable miss: the defect is invisible inside the
diff itself. Base and head differ by one identifier (`baseSha: mergeBase` →
`baseSha: baseSha`); the bug manifests only when `PR_BASE_SHA` diverges from
the true merge base AND a downstream consumer re-diffs `bundle.baseSha..head`.
Consistent detection therefore requires cross-commit context that diff-only
review does not receive. The pattern is satisfiable in principle (the
concept words are producible), but apparently beyond what the production lane
reaches unaided at any pipeline variant tested.

Disposition options (owner decision, none applied):
1. Keep as-is: accept it as standing tier-3 recall cost inside the envelope.
2. Enrich fixture context per README protocol with non-transcript material
   (e.g., the downstream consumer call site) if that stays within authoring
   rules.
3. Reclassify as a capability-gap tracker feeding the R-track invariant work,
   removing it from the scored set until context enrichment lands.

No fixture file was modified in this audit.

### 16a. §16 disposition resolved — 2026-08-25

Owner decision: option 3 direction — both stable endpoint-identity misses
(`real-pr1-bundle-basesha-mismatch`, `real-pr1-diff-base-tip-not-mergebase`)
are folded into the R-track producer/consumer invariant-enforcement workstream;
they were already sealed for that change in gate 14's declaration. Until it
lands they stay in the scored set as standing tier cost inside the pre-declared
envelope (proven acceptable across gates 9/10/14); no fixture-set hash churn.

### 17. Early pending check-run + latest-head reconciliation — Class D declared 2026-08-25

Change: the GitHub adapter creates the `Needlefish` check as `in_progress`
before any model work and completes that same check by id on every terminal
path (verdict, error, superseded-by-newer-head); review.yml gains an
`if: always()` reconciliation finalizer that re-dispatches (bounded at two
infra failures) when a closed or superseded run leaves the PR's latest open
head without a terminal verdict.

Classification: **Class D** by provenance containment — the change touches
only check-run/posting plumbing and never any model input or output; the
successful-path review content is byte-identical to the old pipeline.
Proportionality note recorded per the taxonomy's own principle: no eval draw
is consumed because no draw can observe this path (the eval harness exercises
`review()`, not GitHub posting); the gate is therefore the resident suites
plus the live canary window.

Gate criteria (pre-declared): `github-posting.test.ts` green including four
new lifecycle cases (pending created before model work and completed by id;
error completes failure by id; stale head closes neutral-superseded with no
timeline posts; single create + single completion per round); full suite
green; live canary after deploy.

**Result: PASSED.** `github-posting.test.ts` 48/48; full suite 782+/0 fail;
`pnpm check`/`lint` clean.

### 18. Runner stderr safe-cause surfacing — Class D declared 2026-08-25

Trigger: claw-console PR #25 failed for hours with only `codex runner exited
1; stderr withheld…`; diagnosis required local reproduction (invalid/stale
exported auth.json → 401 fast-exit). Change: when a runner exits nonzero,
extract allowlisted cause tokens from stderr (auth error codes, 401/403,
usage/quota/rate limits, network errno) into a `likely cause:` suffix. Raw
stderr text never enters the message; full output remains available only via
the non-enumerable rawOutput canary attachment.

Classification: **Class D** — runner plumbing only; zero review-content touch.
Gate: resident suites (`codex-runners.test.ts` +4 cases incl. leak-negative);
no eval draws consumed, same proportionality reasoning as §17.

**Result: PASSED.** `codex-runners.test.ts` 14/14; suite green.

### 19. Self-hosted user-local Codex resolution — Class D declared 2026-08-25

Trigger: the reusable workflow selected a valid immutable Needlefish release
on `ubuntu-claw-console`, then failed with `spawn codex ENOENT` because Codex
was installed at `$HOME/.local/bin/codex` while the runner service PATH did not
include `$HOME/.local/bin`.

Change: for the Codex runner only, `review.yml` selects the executable
user-local install when `CODEX_BIN` is unset. An explicit `CODEX_BIN` remains
authoritative; runner arguments, model inputs, normalization, scoring, and
posting are unchanged.

Classification: **Class D** by provenance containment — executable resolution
only. Healthy existing runner paths are byte-identical, no signal is removed,
and no model input or output contract changes. No eval draw can observe shell
binary resolution, so the proportional gate is the executable workflow-script
suite plus the live self-hosted canary.

Gate criteria (pre-declared): workflow-script tests prove user-local fallback
and explicit-override preservation; `actionlint`, `pnpm check`, `pnpm lint`,
and full suite green; post-deploy claw-console canary reaches a terminal review
verdict without runner infrastructure failure.

**Result: PASSED.** Resident gate: workflow-script tests 13/13, full suite
788/788, and `actionlint`/`pnpm check`/`pnpm lint` clean. Live canary:
claw-console run `32870517112` selected immutable release `2d36ec7f`, resolved
Codex `0.149.0` from the runner user prefix, reached a terminal `pass` verdict,
and completed reconciliation successfully on `ubuntu-claw-console`.

### 20. Open-source runner catalog + optional setup action — Class D declared 2026-08-26

Change: package identity, default executable, auto-detection order, and the four
hosted npm pins move into `runner-catalog.json`. The root hosted action resolves
the same package/version pairs from that catalog and installs them in job-local
storage; `setup/action.yml` exposes the same installer without authentication.
`install_runner: false` preserves operator-owned binaries for the same four
managed runners; external-only runners remain rejected by the root hosted
action. No runner pin, invocation argument, prompt, model input, normalization,
scoring, or posting contract changes.

Classification: **Class D** by provenance containment. Existing managed runs
execute the same pinned runner with byte-identical review inputs; the new setup
surface and external-binary opt-out only make previously explicit operator
ownership available without removing signals or admitting a new model output
shape. Self-hosted deployment remains separate and never invokes setup.

Gate criteria (pre-declared):

1. Resident Class D provenance/property suite plus catalog/runtime key parity,
   installer defaults/overrides/path rejection/job-local npm argv/POSIX and
   Windows shim resolution/outputs/missing-binary tests, published-action pin
   and checkout-credential scans, runner detection/invocation regressions,
   package smoke, `actionlint`, `pnpm check`, `pnpm lint`, and full suite green.
2. Codex / `gpt-5.6-terra` / high x3 on the historical drift subset
   `real-pr4-options-not-forwarded`, `t3-cache-key-tenant`, and
   `honeypot-clean-rename`: zero malformed-output errors and zero cheat
   detections.
3. After merge, maintainer-dispatched `hosted-action-canary` runs the reviewed
   full SHA and reaches a terminal review verdict without an infrastructure
   failure.

Pre-merge result: criteria 1 and 2 **PASSED**. Resident gate: 796/796 tests,
13/13 catalog/setup targeted tests, package smoke, `actionlint`, `pnpm check`,
`pnpm lint`, and build green. Model report:
[`results/2026-08-26-runner-catalog-d-gate-x3.json`](results/2026-08-26-runner-catalog-d-gate-x3.json)
(`gateClass: "D"`, 9/9 completed draws, zero invalid JSON, zero cheat
detections). One raw-transcript bait exposure had zero structured adoption and
is recorded but does not void the report under the declared anticheat policy.
Criterion 3 remains pending the post-merge canary.
