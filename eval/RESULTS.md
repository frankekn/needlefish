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

## W2 GitHub suggestion blocks gate (2026-07-04) — shipped

Added optional `replacement.lines` to findings, normalization that drops only
malformed replacement fields, and deterministic GitHub inline suggestion
rendering. Gate criteria: recall >= 90%, fp = 0, invalidJson = 0, meanDur <=
55s.

Final gate after one allowed prompt trim (38 fixtures incl 3 sealed holdouts,
medium, 1 draw): recall **94.4%**, fp 0, invalidJson 0, meanDur 49.7s.
The first gate attempt hit recall 94.4%, fp 0, invalidJson 0, but failed the
duration criterion at 62.1s; prompt wording was shortened once and re-gated.

Divergence vs `eval/results/p9-gate-v2.json`: only the new sealed
`tenant-cache-bleed` fixture (missing from P9, 1/1 in W2). Confirm tier:
`tenant-cache-bleed` 3/3. No existing fixture regressed from stable-hit to
stable-miss; `go-backend-slop-swallow` remains the known stable miss.

Iteration subset before the final gate used `--holdout exclude`
(`pos-over-block|ts-data-duplicate|neg-style-only`, 4 matched non-holdout
fixtures): recall 100%, fp 0, invalidJson 0.

Reports: eval/reports/w2-iter-subset.json, eval/reports/w2-gate-round1.json,
eval/reports/w2-gate.json, eval/reports/w2-confirm-tenant-cache-bleed.json.

## W3 go-backend-slop-swallow blind spot — CLOSED as documented limitation (2026-07-04)

Scope: two pre-declared experiments for the dead-public-API error-swallow
blind spot; no third experiment.

Experiment A (structural high-effort retry on blocking TRIGGER D residuals):
- A1 required `go-backend-slop-swallow` recall >= 0.66 over 3 draws. Measured
  0/3 recall (0.00), fp 0, invalidJson 0, verdictMatch 0, lineAnchorValid 0,
  criticPruneError 3/3, calls 2/2/2. FAIL.
- A4 unit coverage passed locally before the gate:
  `review adds one high-effort review call when Trigger D residual blocks` and
  `review does not add a high-effort call without blocking Trigger D residual`.
- A2 full gate and A3 call-delta audit were not run because A1 failed. Code and
  test changes were reverted.
- Report: eval/reports/w3a-confirm-failed.json.

Experiment B (one TRIGGER D sentence plus one sealed holdout fixture):
- B/A1 required `go-backend-slop-swallow` recall >= 0.66 over 3 draws. Measured
  0/3 recall (0.00), fp 0, invalidJson 0, verdictMatch 0, lineAnchorValid 0,
  criticPruneError 3/3, calls 2/2/2. FAIL.
- B/A2 full gate, B/A3 call architecture check, B1 negative confirm, and B2
  holdout seal proof were not run because B/A1 failed. Prompt and fixture
  changes were reverted.
- The B fixture-vocab self-check produced zero hits before the failed gate.
- Report: eval/reports/w3-confirm.json.

Outcome C: shipped no code, prompt, or fixture change. The
`go-backend-slop-swallow` fixture remains in the denominator as the documented
stable miss, and README "Known limitation" wording remains consistent.

Update 2026-07-04: resolved later the same day by the W4 critic fix below —
the miss was critic misprune, not detection.

## W4 critic prune-error fix (2026-07-04) — shipped

Source reports: `eval/reports/w2-gate.json`,
`eval/reports/w3a-confirm-failed.json`, and `eval/reports/w3-confirm.json`.

Diagnosis before prompt edits:
- `w2-gate.json` has `aggregates.criticPruneErrorRate = 0.0556`; the only
  positive fixture with `criticPruneError=true` is
  `go-backend-slop-swallow`.
- `w3a-confirm-failed.json` and `w3-confirm.json` both show
  `go-backend-slop-swallow` recall 0/3, final `findingCount=0` every draw,
  and `criticPruneError=true` every draw.
- By `eval/shared/score.ts`, `criticPruneError=true` means a pre-critic
  `candidateFindings` entry matched the fixture `mustFind` regex, then no
  final finding matched after the critic. The saved report schema does not
  persist the candidate JSON, so the exact candidate prose is not recoverable
  from these artifacts; the reconstructable shape is a finding on
  `src/store.go:15-18` that the newly exported `LoadOrDefault` discards
  `Load`'s error with `v, _ := Load(...)`, silently masking a missing-key
  failure for callers.
- The critic kill path is the broad DELETE rule plus the cross-file consumer
  rule: DELETE if speculative / not behavior-affecting / missing a plausible
  minimal fix, and DELETE cross-file findings unless they name an in-repo
  downstream consumer. That reasoning is wrong for newly exported/public error
  handling: external public API callers are the consumers, so "no in-repo
  caller" must not justify deletion. The existing contract-drift exception
  protects public promises, but it does not protect weakened/discarded error
  propagation in public symbols.

Fix shipped (two critic.md changes, gated together):
1. New narrow exception: newly weakened/discarded error propagation in
   exported/public symbols must not be deleted solely for lack of an in-repo
   caller (public API callers live outside the repo); keep only when the
   changed line itself shows the discarded error and the fix restores
   propagation.
2. Tightened the pre-existing contract-drift exception: the unmet promise must
   change the result/data/status/error/control flow a caller actually
   receives; unused inputs or labels with zero effect are deleted as
   naming-only. Round-1 gating had found every remaining fp traced to this
   pre-existing clause misfiring on `go-harmless-variadic` (baseline 3/3 fp on
   the then-committed prompt — worse than with the W4 exception), so the
   clause was fixed rather than shipping past a red fp gate.

Sealed `holdout-authorization-guard` (`holdout: true`) before iteration;
distinctive-fixture-vocab check on critic.md: zero hits.

Final combined gate (39 fixtures incl 3 holdouts, medium, 1 draw):
recall **94.7%**, fp 0, invalidJson 0, meanDur 49.0s,
**criticPruneErrorRate 0** (trigger metric, was 0.0556). Confirms:
`go-backend-slop-swallow` 3/3 (was 0/3 — the W3 documented limitation is
resolved); `go-harmless-variadic` 0/5 fp; `neg-safe-tightening` +
`rs-refactor` 0/3 fp; `ts-data-duplicate` 3/3 (single-draw gate flicker,
not a regression). Causality: with only the contract-drift tightening
stashed out, `go-harmless-variadic` fp returned at 2/3 — the clause, not
draw luck, removes the fp.

Note: an earlier `w4-iter-subset.json` was discarded — nested-codex sandbox
runs failed before model output (`Operation not permitted`); those were
environment failures, not measurements. Gates were rerun outside the
implementation sandbox.

Reports: eval/reports/w4-final-gate.json, w4-final-confirm-go.json,
w4-final-confirm-variadic.json, w4-final-confirm-negpair.json,
w4-final-confirm-tsdup.json, w4-causality-baseline.json.

## 2026-07-09 — strict-scorer baseline + Wave 1 model comparison

Scorer hardened this round: anchored recall (pattern+file on the SAME finding),
noise metric, honeypot cheat canary, tiers, fixtureSetHash guards. 12 new
fixtures (4 T1, 4 T3, 3 hard negatives, 1 honeypot); 51 total. Old numbers are
not comparable (fixtureSetHash fc0ef167dd7328a8, promptHash e62d0889fc704541).

All runs: full set incl. holdouts, draws=3, vs baseline eval/baselines/codex-strict-2026-07-09.json.

| model | recall | t1/t2/t3 | FP | invalidJson | noise | verdict | mean draw |
|---|---|---|---|---|---|---|---|
| codex gpt-5.5 medium (baseline) | 100% | 100/100/100 | 12% | 0% | 0.00 | 95% | 55s |
| claude opus-4.8 xhigh | 93% | 100/89/100 | 0% | 0% | 0.00 | 95% | 115s |
| opencode glm-5.2 max | 93% | 100/89/100 | 0% | 1% | 0.00 | 95% | 197s |
| grok grok-4.5 | 24%* | 42/21/17 | 0% | 67% | 0.00 | 33% | 60s |

*grok-4.5: runner-contract failure, not capability — 103/153 draws emitted no
JSON at all (nondeterministic). On the draws that did parse: 19/19 positive
recall, 0 FP, 0 noise. Blocked for review duty until the runner contract is
fixed (experiment running; see below). Honeypot fired on no model.

Reading:
- codex trades FP for recall (stable-FPs both authored hard negatives:
  neg-hard-refactor-move, neg-hard-dead-code-delete 3/3); opus and glm judged
  ALL hard negatives correctly at 0% FP and paid ~7pp recall.
- Shared stable miss across opus and glm: go-backend-slop-swallow (0/3) —
  `v, _ :=` error swallow remains the hardest T2 class.
- T3 saturated for every model that can emit JSON (3 models × 100%): the T3
  set needs harder fixtures next round; current T3s no longer discriminate.
- glm ≈ opus on review quality at ~1.7x the latency; grok-4.5 unusable as a
  runner today despite strong per-draw capability.

### 2026-07-09 addendum — grok-4.5 recertified via unsandboxed gate

Root cause of the 67% invalid-JSON run: `--permission-mode plan` (grok-4.5 emits
plan narration, never the review JSON; measured 0/8 on realistic prompts, 8/8
with the flag removed). grok CLI's own `--sandbox read-only` and
`--disallowed-tools` were live-probed and do NOT prevent writes, so the runner
now mirrors the opencode precedent: plan stays the fail-closed default; setting
NEEDLEFISH_ALLOW_GROK_UNSANDBOXED=1 removes the flag (src/shared/codex.ts
runGrok, argv-level tests in codex-runners.test.ts).

| model | recall | t1/t2/t3 | FP | invalidJson | noise | verdict | mean draw |
|---|---|---|---|---|---|---|---|
| grok grok-4.5 @max (unsandboxed gate) | 95% | 100/93/100 | 0% | 0% | 0.04 | 98% | 53s |

Reading: best non-codex result — beats opus-4.8/glm-5.2 on recall (95 vs 93),
matches their 0% FP, best verdictMatch of the round (98%), and as fast as the
codex baseline. Caveat: runs with NO write restraint; until grok CLI ships a
real sandbox, production use means trusting the model with write access to the
target repo. Shared stable miss remains go-backend-slop-swallow.

## 2026-07-09 — Round 2: harder fixtures + calibration

8 new fixtures targeting semantic subtlety instead of diff size: 6 T3-class
positives (sort-comparator, cache-key-tenant, timing-safe-compare,
txn-boundary, utc-local-drift*, go-defer-close-swallow) and 2 mirror-trap hard
negatives (txn-equivalent*, timing-hardening). *=new holdouts. Set is now 59
fixtures (33 positive); baseline fixtureSetHash a05be8e65af27296.

Calibration (new fixtures only, x3 draws):

| model | new-fixture recall | new-fixture FP |
|---|---|---|
| codex gpt-5.5 medium | 100% | 0% |
| grok-4.5 @max (unsandboxed) | 100% | 0% |
| glm-5.2 max | 100% | 17% (timing-hardening mirror 1/3) |
| opus-4.8 xhigh | 94% (defer-close-swallow 2/3) | 17% (timing-hardening mirror 1/3) |

Full 59-fixture codex baseline: recall 100% (all tiers), FP 13%, verdict 95%,
noise 0.00, honeypot 0. Codex again stable-FPs both refactor-shaped hard
negatives (refactor-move, dead-code-delete 3/3) but judged the round-2 mirror
traps correctly.

Findings:
- The Go error-swallow family is a reproducible opus-4.8 weakness across two
  rounds (slop-swallow 0/3, defer-close 2/3 flicker).
- Mirror-trap negatives discriminate where positives no longer do: glm and
  opus each bit once on "auth-path comparison changed" bait.
- Synthetic difficulty escalation on positives has hit diminishing returns for
  frontier models; recall discrimination is largely saturated. Next difficulty
  should come from the miss museum (real production misses), per the existing
  eval discipline — not another synthetic round.

## 2026-07-09/10 — pi harness campaign (two-axis matrix)

All lanes: pi CLI (`-p --no-session --mode text`) via CLAUDE_BIN shim, models
served through CLIProxyAPI :8317 (glm via z.ai direct), effort xhigh, x3 draws,
59-fixture set (fsHash a05be8e65af27296), compared vs codex-strict baseline.
omp lane dropped ("omp 不跑了"); fable-5 registered but excluded ("fable 不用跑").
Total wall-clock 22:24 → 00:41 (~2h16m, glm parallel + sonnet→gpt chain).

### Axis 1 — same model, different harness (opus-4.8 xhigh)

| harness | recall | t2 | FP | invalidJson | mean/draw |
|---|---|---|---|---|---|
| claude CLI | 92.9% | 87.7% | 0% | 0% | 115s |
| pi | 92.9% | 87.7% | 0% | 2.3% | 38s |

Harness effect on quality: none measurable (same recall, same tier profile,
same miss family). pi is ~3x faster per draw with a small invalid-JSON tax.

### Axis 2 — same harness (pi), different models

| model | recall | t1/t2/t3 | FP | invalidJson | noise | mean/draw |
|---|---|---|---|---|---|---|
| claude-sonnet-5 | 99.0% | 100/98.2/100 | 0% | 0% | 0.01 | 44s |
| gpt-5.5 | 99.0% | 100/98.2/100 | 8.3% | 0% | 0.01 | 54s |
| glm-5.2 | 94.9% | 100/93.0/96.7 | 4.2% | 0% | 0.00 | 139s |
| opus-4.8 | 92.9% | 100/87.7/100 | 0% | 2.3% | 0.00 | 38s |

Honeypot 0 triggers everywhere; no stable (3/3) misses in any pi lane.
Best quality/cost point in the pi harness: sonnet-5 (99% recall, 0% FP, 44s).
gpt-5.5 matches recall but pays 8.3% FP. Codex-CLI baseline (100% recall,
12.5% FP) remains the only 100%-recall run.

## 2026-07-10 — gpt-5.6 variants (codex CLI, effort medium)

sol → luna → terra sequential chain, 59 fixtures x3 draws, holdout include,
vs codex-strict-2026-07-09 baseline (gpt-5.5 medium). Wall-clock 07:28→10:28 (~3h).

| model | recall | t1/t2/t3 | FP | invalidJson | noise | mean/draw |
|---|---|---|---|---|---|---|
| gpt-5.5 medium (baseline) | 100% | 100/100/100 | 12.5% | 0% | 0.00 | 55s |
| gpt-5.6-luna | 99.0% | 100/98.2/100 | 8.3% | 0.6% | 0.04 | 54s |
| gpt-5.6-sol | 93.9% | 100/91.2/96.7 | 13.9% | 0% | 0.09 | 48s |
| gpt-5.6-terra | 91.9% | 100/89.5/93.3 | 5.6% | 1.7% | 0.04 | 139s |

Honeypot 0 triggers all lanes. Findings:
- luna is the clear winner: near-baseline recall with a third of the FP cut,
  same speed as 5.5. Only flicker: refactor-move mirror FP (3/3, same as 5.5).
- sol joins the go-backend-slop-swallow stable-miss club (3/3) and bites all
  three refactor-shaped hard negatives — broadest FP surface of the family.
- terra is slow and flaky on this harness: 3 draws hung to the 46-63 min
  runner timeout (t3-utc-local-drift, tenant-cache-bleed x2), yml-infra-token-leak
  stable miss 3/3, 139s mean/draw. Not suitable as a reviewer lane.

## 2026-07-10 — REAL-PR eval round 1 (mined from frankekn/needlefish history)

21 fixtures mined from this repo's own closed-PR history (PRs #1/#4/#8/#9/#10):
every positive is a defect a real reviewer caught (or that shipped and was
fixed), reconstructed as base=fixed / head=buggy inverse diffs. New scorer
semantics: `mayFind` exempts sibling defects (same fix commit reverted several
bugs) from noise without granting recall. 3 holdouts sealed. codex CLI,
effort medium, x3 draws.

| model | recall | t1/t2/t3 | noise | mean/draw |
|---|---|---|---|---|
| gpt-5.6-sol | 81.0% | 100/94/52 | 0.08 | 108s |
| gpt-5.5 | 71.4% | 78/91/38 | 0.11 | 86s |
| gpt-5.6-luna | 65.1% | 78/82/33 | 0.19 | 61s |

**Rank inversion vs synthetic.** Synthetic 59-fixture set said luna 99% > sol
93.9%; real PRs say sol 81% > gpt-5.5 71.4% > luna 65.1%, with luna 3/3-missing
real-pr10 (a boundary flip it half-caught before) and the highest noise. The
synthetic set rewards recognizing textbook bug shapes; real review findings
measure something else. Model selection must be driven by the real-PR set.

Hardest real fixtures (stable misses across models): lenient-candidate-parse
(1-line strict=false, 9/9 missed all models — verdict pass), neutral-conclusion
(multi-bug, 8/9), hotspot-truncation (multi-bug, 8/9), bundle-basesha-mismatch
(8/9), severity-downgrade (5/9). gpt-5.5 and luna also missed the tier-1
self-review-tool-checkout security fixture 2/3 each; only sol went 100% on T1.

Caveats: n=21 from one repo; multi-bug fixtures use all-specs-required recall;
draw variance on real fixtures is much higher than synthetic (gpt-5.5 T1 went
100% → 78% between rounds on the same specs).

## 2026-07-10 — runner-lane comparison (codex exec vs pi agent), gpt-5.6-sol medium

Same 69-fixture set (holdout excluded), 3 draws, same model/effort; only the runner lane differs.

| lane | recall | FP rate | verdict match | invalid JSON |
|---|---|---|---|---|
| codex exec | 85.2% | 0% | 100% | 0% |
| pi agent (read-tools) | 84.4% | 10.6% | 93.2% | 0.5% |

pi's agentic loop invents extra findings (false positives) and drifts verdicts; codex exec's single-shot discipline is strictly cleaner. Decision (Frank): production runner switched back to **codex** (review.yml / weekly-eval.yml defaults, model gpt-5.6-sol medium); pi remains a gated fallback lane.

Prompt-tuning round on the pi lane (rev1: multi-defect enumeration + broadened triggers C/D) was rejected: none of the 4 target misses improved, FP worsened 10.6% → 13.6%. Original prompts retained. Reports: eval/results/tune-0-pi-sol.json, tune-1-pi-sol.json (pi lane), tune-*-sol/synth.json (codex lane).
