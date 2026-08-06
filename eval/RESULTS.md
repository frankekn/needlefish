# Needlefish evaluation results

This document records what the evaluation program established, what shipped,
and why. The [full chronological record](RESULTS_HISTORY.md) preserves the
original experiment notes, per-fixture matrices, failed gates, and report
paths.

---

## 🏆 Current decision

**Keep Codex `gpt-5.6-terra` at high effort as production baseline.**

| Lane | Status | Verdict |
| --- | --- | --- |
| **Terra high** | 🟢 Production | Keep |
| **Kimi K3 max** | 🟡 Challenger | Strong x1; needs x3 |
| **DeepSeek V4 Flash max** | 🔴 Failed gate | 44% invalid JSON; 594s mean |

> [!IMPORTANT]
> Kimi matched Terra-level recall in one clean draw, but model rankings require
> three full draws. It is not eligible for promotion until x3 confirmation.

---

## 📊 Guarded run scoreboard

All runs below share the same prompt, fixture set, scorer, and anti-cheat
version. Higher recall is better; false positives, invalid JSON, and duration
are better low.

| Metric | Terra baseline | Kimi K3 x1 | DeepSeek x3 |
| --- | ---: | ---: | ---: |
| Completed draws | 252/252 | 84/84 | 252/252 |
| Full-set repetitions | **3** | 1 | **3** |
| **Recall** | 87.4% | **89.7%** | 37.4% |
| **Tier-1 recall** | **100%** | **100%** | 52.4% |
| False positives | 5.6% | **0%** | 1.4% |
| Invalid JSON | 1.2% | **0%** | 44.0% |
| Verdict match | 94.4% | **96.4%** | 53.6% |
| Valid anchors | 88.1% | **90.5%** | 52.0% |
| Mean duration | **56.8s** | 121.0s | 594.4s |

<details>
<summary><strong>Run provenance and reports</strong></summary>

- Prompt: `e62d0889fc704541`
- Fixture set: `1968a9d2fabe2a56`
- Scorer: `a424d3bb59a40443`
- Anti-cheat: v2
- Reports: [Kimi K3 x1](results/2026-08-05-opencode-kimi-k3-max-x1.json) ·
  [DeepSeek x3](results/2026-08-05-opencode-deepseek-v4-flash-max-x3.json)

</details>

---

## 📖 Reading the scoreboard

| Metric | Meaning | Gate rule |
| --- | --- | --- |
| **Recall** | Share of planted defects found, with matching anchor | Higher is better |
| **Tier-1 recall** | Defects that must never be missed | **Any miss disqualifies** |
| **False positives** | Blocking findings on known-clean fixtures | Lower is better |
| **Invalid JSON** | Runner output unusable by the deterministic pipeline | Lower is better |
| **Verdict match** | Final deterministic verdict matches expected outcome | Higher is better |
| **Valid anchors** | Findings point to changed lines that can be acted on | Higher is better |
| **x1 vs x3** | One draw is directional; three draws are required | **No x1 promotions** |

Only runs with matching prompt, fixture-set, scorer, and anti-cheat hashes are
directly comparable. A runner and model form one lane; changing the runner can
change both output quality and reliability.

> [!NOTE]
> Public benchmark scores are not trusted: public-codebase tasks enter training
> data, so they measure memorization. Model selection here uses private
> real-PR fixtures only, with sealed holdouts and anti-cheat canaries.

---

## ✅ Conclusions that survived repeated testing

1. **Real PR fixtures decide model selection.** Synthetic fixtures eventually
   saturated and produced a different ranking from defects mined from actual
   pull requests.
2. **More reasoning effort does not guarantee more recall.** Higher effort
   often reduced false positives while missing more real defects.
3. **Runner behavior matters.** The same model behaved differently through
   Codex, pi, Grok, and OpenCode. Runner failures are not model failures.
4. **Longer prompts often reduce recall.** Several trigger additions and prompt
   packs suppressed finding generation instead of improving it.
5. **The critic can erase correct findings.** This caused the original
   `go-backend-slop-swallow` miss and part of the
   `bundle-basesha-mismatch` failure mode.
6. **Security and isolation remain hard gates.** Anti-cheat canaries never
   appeared in findings, while Grok's useful lane still requires accepting an
   unsandboxed runner.

---

## 🧪 Experiment record

### 1. Prompt and critic foundation — 2026-07-02 → 2026-07-04

| Experiment | Result | Decision |
| --- | --- | --- |
| Raw diff instead of escaped JSON | Recall 78.6% → 85.7%; no FP or JSON regression | 🟢 Shipped |
| Medium vs xhigh effort | Recall 92.9% vs 85.7%; 44s vs 146s | 🟢 Medium |
| Conditional Trigger-A sweep | Same recall, 50% more calls, 60s → 79s | 🔴 Reverted |
| Trigger C/D prompt gate | Recall 94.1%, FP 0, invalid JSON 0 | 🟢 Shipped |
| GitHub suggestion blocks | Recall 94.4%, FP 0, invalid JSON 0, 49.7s | 🟢 Shipped |
| High-effort retry for public error swallowing | Target remained 0/3 | 🔴 Reverted |
| Critic error-propagation exception | Recall 94.7%; prune errors 5.56% → 0 | 🟢 Shipped |

The important diagnosis was that `go-backend-slop-swallow` was detected by the
review pass and then deleted by the critic. The W4 change narrowly protected
discarded errors in exported APIs while tightening a broader contract-drift
rule that had created false positives. Confirmation moved the target from 0/3
to 3/3 and kept the relevant negative fixtures clean.

Key reports: [P5 arm A](results/gate-p5-armA.json) ·
[P5 arm B](results/gate-p5-armB.json) · [P9 gate](results/p9-gate-v2.json) ·
[W2 gate](reports/w2-gate.json) · [W4 gate](reports/w4-final-gate.json)

### 2. Stronger scorer and early model comparisons — 2026-07-09

The scorer added anchored recall, difficulty tiers, noise, honeypot canaries,
and fixture-set guards. This created a new 51-fixture baseline; older numbers
were no longer comparable.

| Lane | Recall | FP | Invalid JSON | Mean draw |
| --- | ---: | ---: | ---: | ---: |
| Codex gpt-5.5 medium | **100%** | 12% | 0% | 55s |
| Claude Opus 4.8 xhigh | 93% | 0% | 0% | 115s |
| OpenCode GLM 5.2 max | 93% | 0% | 1% | 197s |
| Grok 4.5 initial lane | 24% | 0% | 67% | 60s |
| Grok 4.5 unsandboxed | **95%** | 0% | 0% | 53s |

Grok's first result was a runner-contract failure: plan mode emitted narration
instead of JSON. Removing that mode restored quality, but also removed an
effective write restraint. Grok therefore became a strong challenger, not an
automatic production choice.

Eight harder synthetic fixtures increased the set to 59. Frontier models still
saturated the positive set, while mirror-trap negatives exposed useful precision
differences. This ended synthetic-only difficulty rounds; new difficulty would
come from real misses.

### 3. Harness and GPT-5.6 comparisons — 2026-07-09 → 2026-07-10

Through the pi harness, Opus 4.8 kept the same 92.9% recall as its Claude CLI
lane and ran about three times faster, with a 2.3% invalid-JSON cost. On the
same pi harness, Sonnet 5 was the best quality/cost result: 99% recall, 0% FP,
and 44s per draw.

The first Codex-lane GPT-5.6 synthetic comparison favored Luna:

| Model | Recall | FP | Invalid JSON | Mean draw |
| --- | ---: | ---: | ---: | ---: |
| gpt-5.5 medium | **100%** | 12.5% | 0% | 55s |
| gpt-5.6-luna | 99.0% | 8.3% | 0.6% | 54s |
| gpt-5.6-sol | 93.9% | 13.9% | 0% | **48s** |
| gpt-5.6-terra | 91.9% | **5.6%** | 1.7% | 139s |

That ranking reversed on 21 fixtures mined from real Needlefish PRs:

| Model | Real-PR recall | Tier 1/2/3 | Noise |
| --- | ---: | --- | ---: |
| gpt-5.6-sol | **81.0%** | 100/94/52 | **0.08** |
| gpt-5.5 | 71.4% | 78/91/38 | 0.11 |
| gpt-5.6-luna | 65.1% | 78/82/33 | 0.19 |

This rank inversion established the current policy: production selection must
follow real-PR results, not synthetic headline recall.

The same Sol model also performed more cleanly through Codex than pi: 85.2% vs
84.4% recall, 0% vs 10.6% FP, and 100% vs 93.2% verdict match. Production
returned to the Codex runner; pi remained a fallback.

Prompt additions did not rescue the hard real misses. Trigger E reduced Codex
recall from 92.6% to 88.1%. A pi-specific discipline section improved recall
from 86.7% to 91.1%, but left FP at 13.6% and was not adopted for the fallback
lane. Terra and Luna at xhigh reduced FP but also reduced recall, so production
stayed on Sol medium at that point.

### 4. Self-check and critic investigation — 2026-07-11 → 2026-07-12

Tracing showed that `bundle-basesha-mismatch` had two causes: generation often
failed to produce a candidate, and the critic sometimes deleted a correct
candidate. Seven controlled rounds separated those causes.

| Round | Test | Result | Decision |
| --- | --- | --- | --- |
| 3 | Critic exception on the real miss | Candidate generation remained about 1/5; target 0/3 | 🔴 Reverted |
| 4 | Three synthetic critic-isolation fixtures | 9/9 passed before any change | 🟡 Not justified |
| 5 | Extra post-generation self-check | Targets improved only to 0–1/3; mean 89s exceeded 75s cap | 🔴 Not shipped |
| 6 | Exception measured with end-to-end recall | Prunes fell to 0/3, but recall was only 1/3 | 🔴 Reverted |
| 7 | Seam-isolated x9 test | Candidate present 3/9; critic still pruned 2/3 | 🔴 Abandoned |

The campaign stopped because neither prompt wording nor the extra model call
met its pre-declared gate. The next useful lever is structural measurement:
score individual `mustFind` items so partial progress on multi-defect fixtures
is visible.

After four guard fixtures were added, the 84-fixture Sol baseline was 93.1%
recall, 12.5% FP, 95.2% verdict match, and zero tier-1 misses. Its four misses
were the already-known real tier-3 cases.

### 5. Five-lane x3 matrix and anti-cheat validation — 2026-07-12 → 2026-07-13

| Lane | Recall | FP | Invalid JSON | Verdict match | Mean draw |
| --- | ---: | ---: | ---: | ---: | ---: |
| gpt-5.5 medium | **90.8%** | 9.7% | 0% | 95.2% | 58s |
| gpt-5.6-sol medium | 89.7% | 6.9% | 0% | **95.6%** | 53s |
| Grok 4.5 xhigh | 88.5% | **0%** | 0% | **95.6%** | **50s** |
| gpt-5.6-luna max | 88.5% | 9.7% | 0.4% | 95.2% | 134s |
| Opus 4.8 xhigh via pi | 86.2% | **0%** | 2.8% | 90.1% | 53s |

The x3 run reversed the earlier x1 ordering between Grok and Opus, confirming
that x1 is not enough for rankings. GPT-family lanes shared a stable false
positive on behavior-preserving refactors. Grok removed that FP at a 1.2-point
recall cost versus Sol, but still required unsandboxed execution.

A Phase-1 coverage-plumbing branch stayed within sampling noise on both Sol and
Grok and was cleared to ship. The anti-cheat rerun used ephemeral homes and a
per-run canary; `cheatDetectedCount` remained zero, quality stayed within x3
noise, and the guards added no measurable latency.

Reports: [Grok x3](reports/2026-07-12-grok45-xhigh-x3.json) ·
[Opus x3](reports/2026-07-12-pi-opus48-xhigh-x3.json) ·
[Sol x3](reports/2026-07-12-sol-medium-x3.json) ·
[anti-cheat validation](reports/2026-07-13-anticheat-grok45-x3.json)

### 6. Terra prompt program — 2026-07-18 → 2026-07-19

Terra high became production in PR #29. Four prompt experiments then tested
whether shorter or stricter wording could improve it.

| Experiment | Result | Decision |
| --- | --- | --- |
| Lean prompt | Helped Sol, but reduced Terra real-PR recall | 🔴 Not shipped |
| Issue-sweep batch gate | Terra baseline: 87.4% recall, 6.9% FP, 0.075 noise | 🟢 Code; prompt kept |
| Eight-change quality pack | Recall fell to 75.3% and 76.4% in paired rounds | 🔴 Not shipped |
| A5-only evidence rule | Tier-1 swallowed-error recall fell 100% → 33% | 🔴 Not shipped |

The original lean-prompt rejection initially blamed a fivefold FP increase.
Same-day reruns showed that Terra's FP rate itself drifted by provider window.
A same-window paired test corrected the diagnosis: FP tied, while the lean
prompt still lost real-PR recall. Future Terra prompt comparisons therefore
must run paired in the same window.

Across six controlled comparisons, added wording consistently taxed recall. The
prompt-edit program closed with `e62d0889` as the measured optimum for this
lane. Remaining gains require structural changes rather than more prose.

### 7. Precision challengers — 2026-07-26 → 2026-07-31

Qwen 3.8 Max Preview completed 252 guarded draws with 85.6% recall, 0% FP, 0%
invalid JSON, 91.3% verdict match, and 80.3s mean duration. It failed the
production gate because `real-pr1-self-review-tool-checkout` hit only 2/3; any
tier-1 miss is disqualifying. Qwen remains a precision-oriented second-opinion
candidate. [Report](reports/2026-07-26-qwen38-max-preview-xhigh-x3.json).

DeepSeek then produced the stronger directional result shown in the
2026-07-31 report. Its full x3 confirmation later failed operationally; see the
next section.

### 8. DeepSeek confirmation and Kimi K3 — 2026-08-05

OpenCode initially failed before inference because the staged user config set
the plugin-provided `sisyphus` agent while `--pure` correctly disabled plugins.
Needlefish now explicitly selects OpenCode's built-in `build` agent, preserving
pure-mode isolation and making runner behavior independent of user defaults.

The DeepSeek full x3 run completed all 252 slots but degraded badly: 44.0%
invalid JSON, 37.4% recall, 52.4% tier-1 recall, and 594.4s mean duration. This
failed the gate and is primarily a runner/provider reliability result, not a
promotion-quality model comparison.

Kimi K3 then completed a clean directional x1: 89.7% recall, 100% tier-1
recall, 0% false positives, 0% invalid JSON, 96.4% verdict match, and 121.0s
mean duration. No structured bait use occurred. Kimi advances to a full x3
confirmation before any production decision.

Reports: [DeepSeek x3](results/2026-08-05-opencode-deepseek-v4-flash-max-x3.json) ·
[Kimi K3 x1](results/2026-08-05-opencode-kimi-k3-max-x1.json)

---

## 🗃 Legacy pre-guard benchmark

These early runs used prompt `2d82256f1bb7da69` and a weaker regex-only
scorer. They are retained for historical context, not comparison with current
runs.

<details>
<summary><strong>Show legacy table</strong></summary>

| Lane | Recall | FP | Invalid JSON | Mean draw |
| --- | ---: | ---: | ---: | ---: |
| Codex gpt-5.5 xhigh | 81% | 0% | 0% | 89s |
| Claude Opus 4.7 xhigh | 76% | 2% | 0% | 49s |
| Codex gpt-5.5 medium | 76% | 0% | 0% | 74s |
| Codex gpt-5.5 high | 74% | 2% | 0% | 89s |
| OpenCode DeepSeek max | 67% | 0% | 12% | 184s |
| Claude Opus 4.8 xhigh | 64% | 0% | 0% | 73s |
| OpenCode GLM 5.2 max | 60% | 0% | 5% | 69s |
| OpenCode Kimi max | 60% | 5% | 21% | 188s |
| Grok build 0.1 direct* | 47% | 9% | 2% | 76s |
| OpenCode Qwen max | 36% | 0% | 44% | 150s |
| OpenCode Grok max | 12% | 0% | 56% | 42s |

\*Partial run: 98/102 draws. The Grok Composer partial completed only 52/102
draws and is omitted from this summary table because its subset was biased. The
full matrix, stable misses, false positives, and reliability notes remain in
[the historical record](RESULTS_HISTORY.md).

</details>
