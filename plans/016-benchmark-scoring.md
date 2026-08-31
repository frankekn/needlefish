# Benchmark scoring decision note

Status: accepted, 2026-08-31. Balanced Review Accuracy was selected after
discussion and implemented in the public leaderboard generator.

## Conclusion

The former provisional score was useful as an experiment, but it was not the
best public headline metric:

```text
(recall × specificity × valid-output rate × verdict match)^(1/4)
```

It is not the standard classification G-mean. Standard binary G-mean is only
`sqrt(sensitivity × specificity)`. The current formula gives equal importance
to four measures without a declared user-cost rationale, and two measures are
partly outcomes of the others. Mainstream benchmarks generally rank by one
direct task-success measure and publish reliability, cost, and latency beside
it.

The strongest simple candidates are:

1. capability-first anchored recall, with false-positive rate as the tie-break;
2. balanced review accuracy, `(recall + specificity) / 2`;
3. a cost-sensitive loss, but only after we agree how costly misses, false
   alarms, and unusable outputs are.

Tier-1 recall, report integrity, completeness, and anti-cheat should remain
qualification gates under every policy. Disqualified lanes receive no rank.

## What established benchmarks do

| Benchmark | Primary ranking metric | Secondary evidence | Failed or invalid work | Aggregation | Cost, latency, uncertainty |
| --- | --- | --- | --- | --- | --- |
| SWE-bench | Resolution rate: resolved instances divided by submitted instances. | Submitted, completed, resolved, unresolved, empty patches, and errors are reported separately. | Errors are visible in the evaluation counts rather than becoming a second quality multiplier. Official submissions are pass@1. | One solved/not-solved outcome per submitted instance. | The official board shows average cost and trajectories in separate columns. It does not blend them into `% Resolved`. [Official FAQ](https://www.swebench.com/SWE-bench/faq/), [submission checklist](https://github.com/swe-bench/experiments/blob/main/checklist.md), [leaderboard](https://www.swebench.com/). |
| Aider Polyglot | Percent of tasks completed correctly after the configured tries. | Correct edit-format rate, malformed responses, error outputs, timeouts, tokens, cost, and seconds per case. | A task succeeds only when all tests pass; format and runtime failures remain separately inspectable. | Each exercise contributes one task result. `pass_rate_#` is success after each allowed retry, not a confidence interval from independent full runs. | Cost and seconds per case are separate columns. [Official leaderboard](https://aider.chat/docs/leaderboards/), [benchmark notes](https://aider.chat/docs/leaderboards/notes.html), [benchmark report contract](https://github.com/Aider-AI/aider/blob/main/benchmark/README.md). |
| LiveBench | Overall score. Each task is the arithmetic mean of its questions, each category is the arithmetic mean of its tasks, and the overall score is the arithmetic mean of six categories. | Category and task scores. | Repeated API failures become `$ERROR$` and are considered incorrect after retries. | Hierarchical macro averaging gives each category equal overall weight. | The published scoring method does not mix cost, latency, or repeated-draw uncertainty into quality. Its current official UI derives cost views separately. [ICLR paper](https://proceedings.iclr.cc/paper_files/paper/2025/file/e4a46394ba537b3f9a186a5b4c650d1-Paper-Conference.pdf), [official runner documentation](https://github.com/LiveBench/LiveBench), [official leaderboard UI repository](https://github.com/LiveBench/new-livebench). |
| Terminal-Bench / Harbor | Accuracy: successful trials divided by all trials; pass@2 through pass@5 are also reported. | Token totals, total cost, average duration, reward-hack rate, and pass@k. | An errored trial has no reward and is a failure. A reward-hack-disqualified trial receives zero reward but still counts its resource use. | Raw trial accuracy; pass@k uses the unbiased per-task estimator. | The official implementation reports standard error and keeps cost/duration separate. [Official metric implementation](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/src/leaderboard/core/metrics.py), [leaderboard contract](https://github.com/harbor-framework/terminal-bench-2-1/blob/main/leaderboard/SETUP.md), [Harbor metrics](https://www.harborframework.com/docs/datasets/metrics). |

The shared pattern is a direct, explainable success metric plus separate
diagnostics. LiveBench is the useful exception on aggregation: it deliberately
macro-averages categories so a large category cannot dominate the total.
Terminal-Bench is the strongest precedent here for repeated per-task trials,
uncertainty, and treating unusable trials as failures exactly once.

## Problems with the former provisional formula

### 1. It is an ad hoc geometric mean

The established binary classification G-mean is:

```text
G = sqrt(recall × specificity)
```

It is designed to reward performance on both classes and collapses toward zero
when either class is ignored. Adding validity and verdict match makes the
Needlefish score a new index, not a standard G-mean. [Official imbalanced-learn
definition](https://imbalanced-learn.org/stable/references/generated/imblearn.metrics.geometric_mean_score.html).

### 2. Verdict match overlaps recall and false positives

Needlefish derives the verdict deterministically from blocking findings and
blocking residual risks ([`src/core/verdict.ts`](../src/core/verdict.ts)). The
evaluator then compares that derived verdict with the expected verdict
([`eval/shared/score.ts`](../eval/shared/score.ts)). A missed blocking defect
therefore tends to reduce both recall and verdict match; an invented blocking
finding tends to reduce both specificity and verdict match. Multiplying all of
them gives the same underlying behavior more than one vote.

Verdict match is still valuable as an end-to-end diagnostic. It should not be
an equal independent factor unless we explicitly decide that finding quality
and final disposition are separate user utilities.

### 3. Invalid output is counted asymmetrically and often more than once

For an invalid result, the scorer sets `formatOk=false`, `recall=false`, and
`verdictMatch=false`, while `falsePositive=false`
([`eval/shared/score.ts`](../eval/shared/score.ts)). The current composite can
therefore penalize an invalid positive draw through recall, validity, and
verdict match simultaneously. An invalid negative draw reduces validity and
verdict match but does not reduce specificity. This is not a coherent
classification loss.

Provider outages and subscription caps are operational failures and should be
retried or excluded from model-quality comparison. A model-generated malformed
answer is an end-to-end model/harness failure and should count once in the
appropriate task outcome, not as an extra multiplier.

### 4. Equal weights imply an unstated cost policy

An equal four-way mean says a one-point loss in recall, specificity, validity,
or verdict match deserves the same multiplicative treatment. There is no
evidence that this matches review users' costs. Cost-sensitive decision theory
instead starts with an explicit, economically coherent cost matrix and selects
the action with minimum expected cost. Costs can represent harm or labor, not
only money. [Elkan, *The Foundations of Cost-Sensitive Learning*
(2001)](https://cseweb.ucsd.edu/~elkan/rescale.pdf).

## Candidate policies

Proposal B is the accepted public policy. Proposals A and C remain documented
alternatives.

### Proposal A — capability-first leaderboard

```text
Eligibility:
  complete comparable x3 report
  anti-cheat clean
  Tier-1 recall = 100%

Rank key:
  1. anchored recall, descending
  2. false-positive rate, ascending
```

Keep invalid-output rate, verdict match, mean duration, harness/provider, and
confidence intervals as columns.

Tradeoff: this is the closest to SWE-bench and Aider's direct-success approach
and most clearly answers "which lane finds real defects?" It intentionally
prefers a small recall gain over any non-tied false-positive improvement. That
is appropriate only if missing defects is the dominant product concern.

### Proposal B — balanced review accuracy

```text
R = anchored recall on positive fixtures
S = specificity = 1 - false-positive rate on negative fixtures

Balanced Review Accuracy = (R + S) / 2
```

Balanced accuracy is the unweighted arithmetic mean of class recall; in the
binary case it is `(sensitivity + specificity) / 2`. [Official scikit-learn
definition](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.balanced_accuracy_score.html).

Tradeoff: this is standard, readable, and gives misses and false alarms equal
class-level weight even when positive and negative fixture counts differ. It
does not sharply punish a lane that is very weak on one class. If that behavior
matters, use the standard `sqrt(R × S)` G-mean instead; do not add unrelated
factors to it.

For model-generated invalid outputs, define a usable correct outcome per
scheduled draw: an invalid positive is not a true positive, and an invalid
negative is not a usable true negative. This counts invalidity once. Exclude
verified provider/infrastructure failures from model scoring and disclose them
as operational reliability.

### Proposal C — declared cost-sensitive loss

Use mutually exclusive per-draw outcomes and predeclare costs:

```text
Loss = (Cmiss × FN + Cfalse_alarm × FP + Cunusable × invalid) / N
Utility = 1 - normalized(Loss)
```

Tier-1 misses can retain effectively infinite cost through the existing hard
gate. Publish the chosen cost matrix and a sensitivity table at several
plausible miss:false-alarm ratios.

Tradeoff: this best represents production value when the organization can say,
for example, how many nuisance reviews equal one escaped Tier-2 defect. Without
that product decision, the weights are arbitrary and less trustworthy than
Proposal A or B.

### MCC as a diagnostic, not the public headline

Matthews correlation coefficient uses all four confusion-matrix cells, ranges
from `-1` to `1`, and remains balanced when class sizes differ. [Official
scikit-learn definition](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.matthews_corrcoef.html).
It is statistically useful for regression analysis, but less intuitive than a
percentage and would require reducing each review draw to one binary outcome.
That would hide Needlefish's anchored finding evidence, so MCC is better as a
secondary diagnostic.

## Effect on the completed qualified lanes

Using the current published aggregates, both standard two-factor candidates
preserve the qualified ordering. Values below are illustrative policy
comparisons, not replacement official scores.

| Rank | Lane | Balanced accuracy | Standard G-mean |
| ---: | --- | ---: | ---: |
| 1 | DeepSeek V4 Flash Vision Exp max | 94.72% | 94.69% |
| 2 | Grok 4.6 xhigh | 94.58% | 94.50% |
| 3 | GLM-5.3-Flash max | 94.44% | 94.28% |
| 4 | GPT-5.6 Sol medium | 88.06% | 88.03% |
| 5 | GPT-5.6 Terra xhigh | 87.64% | 87.64% |

Terra high and Luna max remain disqualified and receive no rank under every
proposal because Tier-1 recall is below 100%.

## Gates, aggregation, and uncertainty under any policy

- Gate before ranking: complete x3 coverage, exact comparable hashes, sealed
  holdouts, current scorer and anti-cheat, zero cheat detections, exact declared
  model/harness/provider/effort, and Tier-1 recall of 100%.
- Never turn blocked, unavailable, partial, compromised, or verified
  infrastructure-failed lanes into a zero model score.
- Keep each fixture equally weighted. Because every fixture currently has the
  same three draws, micro-averaging draws and averaging fixture rates are
  equivalent. Continue publishing Tier-1/2/3 recall separately; do not invent
  category weights without a product reason.
- Report uncertainty from the x3 fixture results. A paired bootstrap over
  fixtures is preferable for head-to-head comparisons because every lane sees
  the same fixture set; at minimum, show a confidence interval and declare
  statistically unresolved lanes tied. Terminal-Bench's reported standard
  error is the closest primary benchmark precedent cited above.
- Keep duration and provider cost separate from quality. Show a quality/cost or
  quality/latency Pareto view if enough trustworthy billing data exists; do not
  hide an exchange rate between seconds, dollars, misses, and false alarms in
  one score.

## Decision record

Needlefish uses Proposal B as the public default because it is standard,
explainable, and removes the former double-counting. A model-generated malformed
output counts once as an unusable task outcome; verified provider failures stay
operational and rerunnable. Tier-1, integrity, and completeness remain hard
gates. Cost, latency, validity, verdict match, and uncertainty stay outside the
primary score.
