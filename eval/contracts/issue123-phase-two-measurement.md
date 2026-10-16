# Phase 2 measurement admission

`evaluatePhaseTwoQualification` measures the broad and deep reports against the
supplied frozen `FixtureSpec` set. It does not change the Phase 1 leaderboard,
composite scores, fixture gold, or historical `evaluateCodeReviewQualification`
output. This qualification change is **gateClass: R**. The full Class R model
gate has not run. Phase 2 is not the production policy.

## Coverage

The broad report contains every supplied fixture at every broad draw index.
The deep report contains every supplied positive Tier-1 fixture at every deep
draw index. The policy records both draw counts. The planned campaign uses
three broad draws and six deep draws.

Both reports pass the existing `isCompleteReport` check against their exact
fixture IDs. Missing or duplicate fixtures, missing or duplicate results,
foreign IDs, and fractional, negative, or out-of-range draw indices reject the
input. Array length alone cannot establish completeness. Invalid or compromised
draws prevent eligibility. A complete report can still fail quality gates.

This entry point expects typed reports after the existing report parser.
It does not replace publication checks for lane identity, hashes, operational
failures, provenance, or anti-cheat attestations. The campaign must predeclare
whether broad draws count toward deep draws. This function does not infer that
relationship, merge reports, select reruns, or authorize a sampling design.

## Measurements

Rates publish their numerator and denominator. A zero denominator or absent
required evidence produces `status: "unknown"`, never a perfect score.

- `tierOne` uses deep Tier-1 draws and the existing per-draw recall scorer.
  `recallByTierOneFamily` uses the same Tier-1-only denominator. Lower tiers
  appear separately in `broadRecallByFamilyDiagnostic` and cannot change a
  Tier-1 family gate.
- `localizationByTierOneFamily` is joint recall and localization per deep draw.
  Every required gold must have a file and line oracle. File and line defaults
  come from `Expected`. Every gold must match a distinct finding in that range.
  Missing oracles or omitted findings make the affected family unknown.
  Historical `lineAnchorValid` does not stand in for an oracle.
- `requiredGoldMatchPrecisionProxy.micro` divides one-to-one required-gold
  matches by all emitted P0, P1, and P2 findings across positive and negative
  broad draws. Matching uses the existing single-finding `matchesSpec` contract
  with a mandatory file anchor. A maximum bipartite matching prevents one
  finding from satisfying multiple gold defects or a greedy assignment from
  losing a valid match. Structured facts must be satisfied by that finding.
- `requiredGoldMatchPrecisionProxy.meanPerEmittingReview` averages each emitting
  draw's matched fraction. `abstentionDraws` counts draws with no blocking
  findings. Abstentions contribute neither a perfect fraction nor an emitted
  finding. Honeypots and parity fixtures are outside these proxy denominators.
- The proxy is not actionable precision. It does not independently adjudicate
  legitimate sibling defects or the actionability of unmatched findings.
  `mayFind` does not create a required-gold TP. `actionablePrecision` remains
  unknown until a separately reviewed TP/FP adjudication contract exists.
- `negativeFalsePositiveDrawRate` uses the existing negative score's
  `falsePositive` flag, divided by negative broad draws. It is a per-draw rate,
  not a population false-positive PR rate.
- `meanNoisePerPositive` publishes the existing noise count over positive broad
  draws. The historical `minNoisePerPositive` field names a maximum allowance.
- `observedPassK.fixtureWeighted` averages `C(h_i,k) / C(n_i,k)` equally over
  deep Tier-1 fixtures. Here `h_i` is the number of recalled draws and `n_i` is
  the complete deep draw count. It describes observed all-success subsets.
  It does not cube aggregate recall or claim independent population trials.
- `severityCalibration` remains unknown because `Expected` has no independent
  gold severity labels. Matching a P1 finding does not establish severity
  calibration.

## Eligibility

All floors are explicit caller inputs. `null` means unset and prevents
eligibility. No numerical production floor is selected here. Unknown required
metrics also prevent eligibility, even if all supplied thresholds are zero.
Consequently this implementation cannot qualify a lane while actionable
adjudication and severity labels remain absent.

The existing Phase 2 fixture-plan check still requires at least 15 Tier-1
fixtures, at least five families, and at least two fixtures per family. It
does not establish independent source PRs or production representativeness.

The next policy decision must fix acceptable and unacceptable quality points,
consumer and producer risks, numerical floors, independent localization and
severity gold, actionable adjudication, and the complete campaign protocol.
Existing sealed fixtures and reports remain unchanged. Neither this contract
nor synthetic tests complete issue #123 or replace the full Class R campaign.
