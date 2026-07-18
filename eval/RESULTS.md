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

## 2026-07-10 — tuning round 2 (commander-run), codex + pi lanes in parallel

**codex lane, rev2 = original + TRIGGER E (pipeline misreport):** REJECTED. Full-set recall 92.6% → 88.1%; the three stable real misses (bundle-basesha, hotspot-truncation, neutral-conclusion) stayed at 0 (neutral lost its occasional 0.33); four synthetic fixtures regressed (ts-backend-slop-swallow 1.00→0.33 worst). FP unchanged. Lesson: additive trigger text still dilutes attention on this lane; production prompts remain the committed originals (reverted).

**pi lane, rev2 + "Harness discipline" compensation section** (restates the 5.6 base-prompt rules pi never injects — evidence-led, read-only, refactor-is-not-a-defect, clean-diff⇒PASS): recall 86.7% → 91.1% (best pi-lane result), FP unchanged at 13.6%. The three negative-fixture false positives (go-harmless-variadic, neg-hard-dead-code-delete, neg-hard-refactor-move) are stable 3/3 across both lanes and all prompt versions — model-inherent for gpt-5.6-sol, not prompt-fixable at reasonable cost. Variant prompts archived (not adopted; pi is a fallback lane). Reports: eval/results/tune-2-sol-full.json, tune-2-pi-sol.json.

Standing conclusions: (1) prompts are lane artifacts — a lane switch requires re-tuning on that lane; (2) pi cannot receive OpenAI's per-model instructions_template (pi-ai openai-codex adapter overwrites `instructions` with pi's generic prompt), so a pi promotion must first port the missing discipline into our own prompts.

## 2026-07-10 — high-effort matrix: terra@xhigh, luna@xhigh (codex lane, full set, 3 draws, holdout excluded)

| | sol medium (prod) | terra xhigh | luna xhigh |
|---|---|---|---|
| recall | **92.6%** | 86.7% | 89.6% |
| FP rate | 12.1% | **4.5%** | 7.6% |
| verdict match | 95.2% | 96.1% | 94.7% |
| mean draw | 74s | 81s | 80s |
| wall time (207 draws, conc 3) | — | ~93 min | ~93 min |

- Higher effort buys FP reduction, not recall: terra@xhigh nearly clears the negative-fixture false positives (2/9 draws vs sol's 8/9) but loses 6 recall points, including missing yml-infra-token-leak (security) entirely; luna@xhigh sits in between with many new 0.67 instabilities.
- The three stubborn real misses (bundle-basesha-mismatch, neutral-conclusion, hotspot-truncation) fail under EVERY 5.6 model × effort combination tested (only luna@xhigh scores hotspot 0.33) — 5.6-family blind spot; not addressable by prompt (round-2 evidence) or effort (this round). Revisit with gpt-5.7-nova when available or harness-side self-checks.
- luna@max was started and aborted after 1 draw (149s/draw, ~3× cost; superseded by luna@xhigh per Frank).
- Decision: production stays gpt-5.6-sol medium (recall-first: missed real bugs cost more than two known low-frequency FP patterns). Candidate next probe: sol@high as an FP/recall midpoint.
- Reports: eval/results/2026-07-10-terra-xhigh.json, 2026-07-10-luna-xhigh.json.

## 2026-07-11 — tuning round 3 (commander-run): critic self-inconsistency exception, codex lane

Trigger: first manifest-bearing baseline (2026-07-11-sol-manifest-baseline.json, 80 fixtures with kinds) confirmed 4 real tier-3 misses via x3 (bundle-basesha 0/3, lenient-candidate-parse, neutral-conclusion 1/3, hotspot-truncation 1/3; docker-infra-supply-chain / go-backend-slop-swallow / real-pr10 were single-draw flicker, 3/3 on confirm).

New evidence on bundle-basesha (EVAL_TRACE captures): the miss is DUAL-cause, not a pure model blind spot as round-2 concluded. When generation produces the candidate ("Keep bundle baseSha aligned with the patch base", P2, conf 0.96, correct anchor), the critic deletes it under the cross-file citation rule (rule 8) because whyItBreaks names consumers generically — even though the defect is a single-file self-inconsistency (rule 9 territory). A critic.md EXCEPTION ("self-inconsistent outputs are single-file evidence") demonstrably rescued the finding in the 1/1 traced draw where generation produced it.

Result vs pre-declared criteria (target ≥2/3 recall): FAILED — generation produced the candidate in only ~1/5 new-prompt draws; eval x3 = 0/3. Generation silence dominates; the critic fix alone cannot clear the bar. REVERTED per criteria (promptHash of the tried revision: b6f9afd6088c4ea0; target-only report in session scratchpad, not retained).

Standing conclusions: (1) the critic-prune component of bundle-basesha is real and fixable — next round should first author a GENERIC synthetic fixture where generation reliably surfaces a self-inconsistent-output finding, so the fixture isolates the critic (miss-museum discipline), then re-propose the same exception against that target; (2) "not addressable by prompt" from round 2 needs the trace-level split (candidate vs final) before being trusted — report-level recall alone cannot distinguish generation silence from critic pruning.

Process note: the round's investigation brief named a sealed holdout fixture id before brief-lint existed in the flow (content never entered the tuning context; investigator redacted it). All needlefish dispatch briefs now pass scripts/brief-lint.mjs before sending.

## 2026-07-12 — tuning round 4 (commander-run): critic-isolation fixtures — exception NOT justified, prompt untouched

Goal (round-3 recommendation): author a generic synthetic fixture where generation reliably surfaces a self-inconsistent-output finding, isolating the critic; then re-propose the round-3 critic.md exception against it under fresh pre-declared criteria (session scratchpad tune4-criteria.md, instrument gate declared before any prompt edit).

Instrument attempts (codex gpt-5.6-sol medium, x3 each, current prompt, criticPruneError from EVAL_TRACE candidate-vs-final):
1. `manifest-count-drift` — arithmetic self-inconsistency (emitted count header vs filtered rows): 3/3 recall, 0 prunes. Rule 9 (single-file observability) already protects this flavor.
2. `snapshot-ref-drift` — metadata-label drift WITH an in-file contract comment: 3/3 recall, 0 prunes. Rule 6 (contract drift) / rule 9 already protect it.
3. `publish-commit-drift` — metadata-label drift with NO in-file contract statement + haystack second file (the exact round-3 trigger shape: justification must appeal to unseen downstream consumers): 3/3 recall, 0 prunes.

Verdict: 9/9 draws across three escalating designs — the current critic correctly keeps this defect class in synthetic isolation. The round-3 real-pr1 prune does not reproduce outside the original large real-diff context. Per eval discipline (a prompt change requires a fixture that failed before and passes after), the critic exception is UNJUSTIFIED — prompts/critic.md untouched this round; two-round instrument cap reached, no further redesigns.

Standing conclusions: (1) round-3's "critic-prune component is fixable by exception" is downgraded: the prune is context-dependent (large-diff conditions), not a stable critic policy defect; (2) the remaining lever for bundle-basesha stays generation-side (round-2/3: gpt-5.7-nova or harness self-checks), plus optionally a real-history fixture mined from the original PR via pr2fixture if reproducing the large-diff prune context is ever worth the cost; (3) the three new fixtures are kept as GUARD positives pinning the protections rules 6/9 give this class (any future critic edit that starts pruning them is a regression), and one new sealed holdout of the same class was added per holdout discipline.

Fixture set delta (uncommitted with this entry): +manifest-count-drift, +snapshot-ref-drift, +publish-commit-drift (tier-2 positives, guards), +1 sealed holdout. anchor/leak tests green (10/10). fixtureSetHash changes; next full-set baseline must be re-recorded before aggregate comparisons.

## 2026-07-12 — full-set baseline re-recorded after round-4 fixture additions (sol medium, 84 fixtures, x1, holdout include)

recall 93.1% (t1 100%, t2 100%, t3 76.5%) | FP rate 12.5% | verdict match 95.2% | meanNoisePerPositive 0.034 | cheat 0 | criticPruneErrorRate 0. promptHash e62d0889fc704541 (unchanged from 07-11), fixtureSetHash 0703343edae44d29 (new — 4 fixtures added). Misses are exactly the 4 known real tier-3s (bundle-basesha, lenient-candidate-parse, neutral-conclusion, hotspot-truncation); zero new misses. All four round-4 fixtures pass, including the sealed holdout on its first (final-gate) run. gate-verdict pass=true (tier1Misses 0, noise cap 0.18). Report: eval/results/2026-07-12-sol-baseline-round4.json.
## 2026-07-12 — round 5 (plan 007): post-generation self-check pass — GATE FAILED, not shipped

Plumbing (branch feat/007-selfcheck-pass, codex-sol-medium-implemented, commander-reviewed): union pre-critic selfcheck pass on both paths, NEEDLEFISH_NO_SELFCHECK kill switch, fail-visible blocking residual, promptHash extended; 364/364 tests. Prompt: three-question checklist (self-inconsistent output / leniency shift / conclusion vs evidence), commander-authored, fixture-vocab-checked. Criteria pre-declared (scratchpad tune5-criteria.md) before any run.

Iteration (x3, holdout exclude, 3 real-miss targets + 3 guard positives + 3 stable-FP negatives):
- Round 1: targets 0/3, 0/3, 0/3 — but bundle-basesha draw1 criticPruneError=true (selfcheck PRODUCED the correct candidate; critic pruned it). Trace captures showed neutral-conclusion and hotspot-truncation are multi-mustFind fixtures where the pass reliably lands 1 of 2-3 required findings (partial hits, all-or-nothing recall).
- Round 2 (wording: answer per-site / never stop at first defect; Q1 whyItBreaks must cite both in-file lines, no consumer framing): bundle-basesha 1/3 (+1 more prune), neutral-conclusion 1/3, hotspot 0/3. Guards 6/6, zero NEW FP fixtures, honeypot 0, invalidJson 0. meanDuration 89s (cap 75s).

Verdict per criteria: primary (>=2 of 4 targets >=2/3) unreachable even with a perfect holdout draw; cost cap also exceeded. Two-round iteration cap reached — STOPPED, not shipped. Branch preserved unmerged as evidence; main untouched.

Standing conclusions: (1) the pass DOES elicit the missing candidates sometimes (real movement 0/3 -> 1/3 on two families) — the residual failures are split between generation flicker, the critic pruning the Q1 metadata class ON REAL DIFFS (now reproduced twice on a real fixture with selfcheck active — the reproducible case round 4 lacked; a critic.md exception round now has a legitimate fixture that fails before / would pass after), and all-or-nothing recall on multi-mustFind fixtures hiding partial gains; (2) any retry should either fix the critic prune first or pair with per-mustFind recall accounting in the eval harness; (3) +1 call costs ~+15-45% wall per review — below the plan's 1.6x cap only sometimes; re-estimate before any ship.

## 2026-07-12 — round 6 (commander-run): critic self-inconsistent-output exception — instrument gate FAILED, nothing shipped

Design (criteria pre-declared, scratchpad tune6-criteria.md): the exception ships alone on main; the unmerged feat/007-selfcheck-pass branch (selfcheck active) is the instrument, since it reproduces the critic pruning the correct bundle-basesha candidate (round 5: pruneErr 2/6). Instrument bar: pruneErr 0 AND recall >=2/3 on x3.

Result: pruneErr 0/3 (vs 2/6 without the exception) and the one draw where the candidate was produced survived the critic to full recall — the exception demonstrably stops the prune and does the rescue. But recall 1/3: on the other two draws generation+selfcheck never produced the candidate, so end-to-end recall failed the bar. The allowed one wording revision has no honest use (the bottleneck is candidate production, which critic wording cannot move) — STOPPED per criteria, exception reverted on the branch, main critic.md untouched.

Standing conclusions: (1) the prune half of bundle-basesha now has full before/after evidence on a real fixture (draw-level: 2/6 pruned -> 0/3 pruned, 1 rescued recall); what it lacks is an honestly-scoped shipping criterion, because end-to-end recall bundles in generation flicker; (2) a future round wanting to ship this exception should pre-declare a prune-rate instrument metric (pruneErr = 0 across N draws WHERE the candidate exists, pooled across capture draws if needed) plus the zero-regression main gate (guards, tier1/t2, FP/noise caps) — declared BEFORE runs, per discipline; (3) round-6 criteria design error worth remembering: an instrument criterion must isolate the seam under test, same lesson as round 4's report-level-recall blindness, one layer up.

## 2026-07-12 — round 7 (commander-run): critic exception, seam-isolated instrument — FAILED, exception abandoned

Criteria pre-declared (tune7-criteria.md): same exception text as round 6, frozen; instrument = basesha x9 on the selfcheck branch, PASS iff >=3 candidate-present draws AND criticPruneError 0 across all draws; end-to-end recall context-only.

Result: candidate-present 3/9 (threshold met), criticPruneError 2 (draws 3 and 7) — the exception failed to stop the prune in 2 of 3 candidate-present draws. Round-6's 0/3 was small-n luck; pooled rounds 6+7 rescue rate is 2/4. Instrument FAIL -> exception reverted on the branch, main untouched, STOP per criteria (no retry).

Standing conclusions: (1) the exception TEXT is insufficient on real diffs — the critic prunes the class about half the time regardless; before any further wording round, capture the critic's input/output on pruned draws to see whether the candidate fails the exception's own verify clause or the prune fires under a different rule; (2) the bundle-basesha lane has now consumed rounds 3, 4, 6, 7 with no shippable artifact — campaign paused; the highest-value next work is structural: per-mustFind partial-recall accounting in the eval harness (round-5 conclusion), which would make any future round on multi-defect fixtures measurable.

## 2026-07-12 — challenger lanes x1: grok-4.5 @ xhigh (grok runner), opus-4.8 @ xhigh (pi/cliproxy) — full set, 84 fixtures, holdout include

Both vs sol-medium baseline (recall 93.1% / FP 12.5%). Single draw each; promptHash e62d0889fc704541.

| metric | grok-4.5 xhigh | opus-4.8 xhigh (pi) |
|---|---|---|
| recall | 86.2% (t1 100 / t2 88 / t3 76) | 89.7% (t1 100 / t2 91 / t3 82) |
| falsePositiveRate | 0% | 0% |
| invalidJsonRate | 0% | 2.4% (neg-hard-txn-equivalent, ts-frontend-style-refactor) |
| verdictMatchRate | 92.9% | 91.7% |
| lineAnchorValidRate | 89.3% | 88.1% |
| meanDurationMs | 52s | 53s |

Both challengers: zero FPs on the negative set (baseline 12.5%) at a recall cost. Misses concentrate on real-PR fixtures (shared: real-pr1-bundle-basesha-mismatch, real-pr1-fallback-missing-commit-pin, real-pr1-lenient-candidate-parse, real-pr1-neutral-conclusion, go-backend-slop-swallow; grok also real-pr10 + real-pr4-hotspot-truncation, opus also real-pr4-options-not-forwarded). Lane notes: grok requires NEEDLEFISH_ALLOW_GROK_UNSANDBOXED=1 (plan mode = 0 valid JSON); pi requires NEEDLEFISH_ALLOW_PI_RUNNER=1 + PI_PROVIDER=cliproxy for opus. Single-draw — not rankable until x3 confirm. Reports: eval/reports/2026-07-12-grok45-xhigh.json, eval/reports/2026-07-12-pi-opus48-xhigh.json.

## 2026-07-12 — challenger lanes x3 confirm: grok-4.5 @ xhigh, opus-4.8 @ xhigh (pi/cliproxy) — full set, 84 fixtures, 252 draws each, holdout include

x3 confirms the x1 headline: **both challengers hold 0% FP across all 108 negative draws** (sol baseline 12.5%). x3 also inverts the x1 recall order (opus 89.7 > grok 86.2 at x1; grok 88.5 > opus 86.2 at x3) — single-draw ranking is noise, as suspected.

| metric | grok-4.5 xhigh x3 | opus-4.8 xhigh (pi) x3 | sol-medium x1 |
|---|---|---|---|
| recall | 88.5% (t1 100 / t2 91 / t3 78) | 86.2% (t1 95 / t2 88 / t3 78) | 93.1% |
| mustFindHitRate | 90.3% | 88.2% | — |
| falsePositiveRate | 0% | 0% | 12.5% |
| invalidJsonRate | 0% | 2.8% | 0% |
| verdictMatchRate | 95.6% | 90.1% | 95.2% |
| lineAnchorValidRate | 91.3% | 85.7% | 95.2% |
| meanDurationMs | 50s | 53s | 46s |

Stable misses (3/3) shared by both: go-backend-slop-swallow, real-pr1-fallback-missing-commit-pin, real-pr1-lenient-candidate-parse, real-pr1-neutral-conclusion, real-pr4-hotspot-truncation. grok adds partials on ts-data-duplicate (1/3), real-pr1-bundle-basesha (2/3), real-pr10 (2/3). opus adds real-pr4-options-not-forwarded (3/3) plus 1/3 flakes incl. one t1 (yml-infra-token-leak). opus formatFail is a stable negative-set pattern (neg-hard-timing-hardening 2/3, neg-hard-txn-equivalent 2/3, ts-frontend-style-refactor 2/3, neg-missing-tests-no-bug 1/3), not random flake.

Read: grok-4.5 xhigh dominates opus-4.8-via-pi on every aggregate at equal FP. vs prod (sol medium): grok trades −4.6pt recall for −12.5pt FP with equal verdict match — a real prod-lane candidate; the decision needs a sol-medium x3 on this fixture set for a fair same-N comparison (current baseline is x1). Reports: eval/reports/2026-07-12-grok45-xhigh-x3.json, eval/reports/2026-07-12-pi-opus48-xhigh-x3.json.

## 2026-07-12 — x3 matrix completed: sol medium, gpt-5.5 medium, luna max (codex lane) — full set, 84 fixtures, 252 draws each, holdout include

Completes the five-way x3 matrix (grok-4.5 / opus-4.8 recorded above). promptHash e62d0889fc704541.

| metric | grok-4.5 xhigh | sol medium (prod) | gpt-5.5 medium | luna max | opus-4.8 xhigh (pi) |
|---|---|---|---|---|---|
| recall | 88.5% | 89.7% | **90.8%** | 88.5% | 86.2% |
| mustFindHitRate | 90.3% | 91.3% | **92.9%** | 90.3% | 88.2% |
| falsePositiveRate | **0%** | 6.9% | 9.7% | 9.7% | **0%** |
| invalidJsonRate | 0% | 0% | 0% | 0.4% | 2.8% |
| verdictMatchRate | 95.6% | 95.6% | 95.2% | 95.2% | 90.1% |
| lineAnchorValidRate | 91.3% | 91.3% | 93.7% | 91.3% | 85.7% |
| meanDurationMs | 50s | 53s | 58s | **134s** | 53s |

Key reads:
- **GPT-family stable-FP blind spot**: neg-hard-refactor-move (behavior-preserving move) FPs 3/3 on sol, 5.5, AND luna; neg-hard-dead-code-delete 3/3 on 5.5 and luna. grok/opus: zero FPs in 108 negative draws each. This is a family-level pattern, not a model quirk.
- **luna max is dominated**: same FP as 5.5-medium, equal-or-lower recall, 2.3x slower, and it misses holdout-spec-drift 3/3 plus a t1 (hardcoded-secret) once. Not a candidate at any effort.
- **x1 rankings did not survive x3** (opus>grok at x1 inverted; sol FP 12.5%→6.9%). N=3 is the floor for any ranking claim.
- Head-to-head for prod: grok-4.5 xhigh trades −1.2pt recall for −6.9pt FP vs sol medium at identical verdict match/anchor/speed; sol's one STABLE FP (refactor-move 3/3) is exactly the class that erodes reviewer trust. Open question before any prod switch: grok lane needs NEEDLEFISH_ALLOW_GROK_UNSANDBOXED=1 (no effective CLI sandbox) — a sandbox-risk acceptance, not an eval question.
Reports: eval/reports/2026-07-12-{sol-medium,gpt55-medium,luna-max}-x3.json.

## 2026-07-13 — Phase-1 branch regression (plans/007 M1+M5+M6, feat/review-red-reason-p1) — PASS, no behavior drift

Pre-ship gate for the review-methodology Phase-1 code (touches reviewSmall/reviewLarge coverage plumbing, in the eval path). Full set x3 on the branch, both lanes, vs same-lane 2026-07-12 baselines:

| lane | recall (base) | FP (base) | verdictMatch (base) |
|---|---|---|---|
| grok-4.5 xhigh | 91.4% (88.5%) | 1.4% (0%) | 95.2% (95.6%) |
| sol medium | 87.9% (89.7%) | 9.7% (6.9%) | 94.8% (95.6%) |

Drifts are small, in OPPOSITE directions per lane, and the stable-miss sets are identical to baseline (grok: same 5 fixtures 3/3; sol: refactor-move FP still 3/3) — sampling noise, not a code effect. Verdict: coverage plumbing is behavior-neutral; Phase 1 clear to ship. Reports: eval/reports/2026-07-12-p1branch-{sol,grok45}-x3.json (in the p1 worktree).

## 2026-07-13 — anti-cheat guard validation (grok-4.5 xhigh x3 under sealed conditions)

Contamination check for the 2026-07-12 five-way matrix: same 84 fixtures
(fixtureSetHash 0703343edae44d29, promptHash e62d0889fc704541), same lane
(grok-4.5 xhigh x3), but run on the feat/eval-anticheat branch (2a0d9a0) with
guards default-on: per-draw ephemeral HOME (fresh auth copies, no session
cache/history carryover) + bait answer key `.needlefish/answers.json` planted
in base+head with a per-run UUID canary.

| metric | sealed (2026-07-13) | baseline (2026-07-12) |
|---|---|---|
| recall | 89.7% | 88.5% |
| falsePositiveRate | 0% | 0% |
| verdictMatchRate | 94.8% | 95.6% |
| mustFindHitRate | 91.0% | 90.3% |
| meanDurationMs | 48.8s | 49.7s |
| cheatDetectedCount | 0 | n/a (guard not present) |

No contamination signal: recall/verdict drifts are within x3 sampling noise
(and recall moved UP under guards), the canary never appeared in any finding,
and fail-closed ephemeral-HOME semantics mean every successful draw is itself
evidence the sealed HOME was in use. The 2026-07-12 matrix stands; guards add
no measurable latency. Report: eval/reports/2026-07-13-anticheat-grok45-x3.json.

## 2026-07-18 — plan 010: lean review prompt (dedup per OpenAI GPT-5.6 guide) — NOT SHIPPED

Hypothesis (OpenAI 5.6 prompting guide): stating each rule exactly once
improves adherence. Lean variant (promptHash d048a378): review.md/deep.md with
every duplicated rule collapsed to a single statement (precondition
substitution 4→1 places, trigger re-explanations in Process → bare
references, prefer-zero carve-outs → one-line pointers); trigger definitions,
sandbox boundary, evidence contract untouched. All runs anticheat-v2 guarded,
x3, cheatDetectedCount 0 throughout; baselines eval/baselines/2026-07-18-*.

Verdict by lane (full set incl holdouts, vs same-lane baseline):

| lane | recall | FP | noise | t1 | t2 | t3 |
|---|---|---|---|---|---|---|
| sol medium base | .879 | .111 | .126 | .857 | .931 | .784 |
| sol medium LEAN | .897 | .111 | .092 | .952 | .951 | .765 |
| terra high base | .885 | **.014** | .092 | .905 | .941 | .765 |
| terra high LEAN | .868 | **.069** | .109 | .952 | .902 | .765 |

- sol medium: lean wins recall/noise/t1/t2, ties FP; only t3 −0.019 (≈1 draw).
  Guide's prediction holds on this lane.
- terra high (prod): FAIL — FP ×5, recall/t2/verdictMatch down, broad 3/3→2/3
  regressions. The current prompt's repetitions (prefer-zero carve-outs,
  verdict-gate restatements) are load-bearing for terra's FP discipline.
- Standing conclusion: prompts are lane artifacts; a dedup that helps one
  model regresses another. Prod (terra high since PR #29) keeps the current
  prompt (promptHash e62d0889). Lean variant recorded, not merged.

Reports: eval/reports/2026-07-18-lean010-{sol-medium-x3-exclude,
sol-medium-x3-full,terra-high-x3-full}.json; divergent-fixture x3 confirm
rounds in session scratchpad only (9-draw merged verdicts recorded in plan
010).

## 2026-07-18 — plan 011 issue sweep: shipped through batch gate; terra FP envelope note

Shipped on main after per-lane cross-family review + per-merge gates: weekly
eval on the terra-high prod lane with explicit deploy dispatch (#19, ccbf406);
size-cap-skipped untracked files surfaced in small AND large review paths
(#26, 41d1b34+93e9e2a); PR #28's eval ground-truth re-implemented on v2 —
per-draw finding evidence, gate-verdict recompute, scorerHash comparability
(eaca967). #12 closed as already-fixed (runner-sandbox.ts:67 file-based
apply + passing CJK regression test); #11 closed as superseded.

Batch gate: terra high full set x3 guarded → new reference baseline
`eval/baselines/2026-07-18-terra-high-x3-v2b.json` (anticheat v2 +
scorerHash; the earlier same-day terra baseline predates scorerHash and is
retained as history — consumers refuse it by design). recall .874 / FP .069 /
noise .075 / cheat 0. All per-fixture divergences vs the morning run are ±1
draw except `neg-hard-refactor-move`: 0/3 FP in the morning, 3/3 FP in the
evening run AND 3/3 in a same-config confirm (prompt hash identical, scoring
byte-identical per review) — provider-side behavior drift, matching the
fixture's known FP history on the sol lane. Standing correction: terra-high's
FP floor is NOT the morning 0.014 single point; its observed same-day
envelope is 1–5 FP draws /72. Judge future prompt changes against the v2b
baseline with divergence confirms, not against 0.014.

## 2026-07-18 — plan 010 correction: lean-prompt verdict re-judged under paired measurement

The original terra FAIL leaned on FP ×5 vs the morning baseline — invalidated
by the same-day discovery that terra's FP oscillates by time window on an
IDENTICAL prompt (see plan-011 entry; refactor-move 0/3→3/3→0/3, promptHash
equal). A same-window paired probe (full set ×1 each, launched
simultaneously, harness bytes identical, only prompts differ) shows: FP tied
at 0.083; lean recall 0.845 vs 0.879, losses concentrated in real-PR
fixtures. Across three independent measurements (sol 9-draw confirms, terra
x3 gate, paired x1) lean consistently loses real-PR-mined fixtures while
holding or winning synthetic trigger fixtures. Verdict stands — NOT SHIPPED —
with the corrected reason: consistent real-PR recall deficit, not FP.
Methodology rule going forward: prompt A/Bs on the terra lane are valid only
as same-window paired runs; cross-window comparisons measure the window.
Reports: scratchpad paired-{current,lean}-x1 (session-local); aggregates
recorded here.
