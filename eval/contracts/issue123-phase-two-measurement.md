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
  `mayFind` does not create a required-gold TP. Independent adjudication,
  described below, supplies `actionablePrecision` through an optional oracle.
- `negativeFalsePositiveDrawRate` uses the existing negative score's
  `falsePositive` flag, divided by negative broad draws. It is a per-draw rate,
  not a population false-positive PR rate.
- `meanNoisePerPositive` publishes the existing noise count over positive broad
  draws. The historical `minNoisePerPositive` field names a maximum allowance.
- `observedPassK.fixtureWeighted` averages `C(h_i,k) / C(n_i,k)` equally over
  deep Tier-1 fixtures. Here `h_i` is the number of recalled draws and `n_i` is
  the complete deep draw count. It describes observed all-success subsets.
  It does not cube aggregate recall or claim independent population trials.
- `severityCalibration` compares predicted severity with the accepted gold
  severities only for independently actionable broad findings that have a
  predeclared label. Matching a P1 finding does not establish calibration.
- `severityLabelCoverage` divides labeled actionable broad findings by all
  actionable broad findings. Its independent `minSeverityLabelCoverage` floor
  prevents selective labels from silently qualifying a lane.

## Independent quality oracle

The optional fourth argument to `evaluatePhaseTwoQualification` is external
oracle data. It follows `PhaseTwoQualityOracle` in
`eval/shared/quality-oracle.ts`. The evaluator validates its version and shape
with the existing Ajv dependency. Invalid data rejects the input. Partial
adjudication produces unknown metrics and prevents eligibility.

The version 1 contract contains these fields:

- `schemaVersion` is `1`.
- `identity` contains `broadSha256`, `deepSha256`, and `fixtureSetSha256`.
  `phaseTwoOracleIdentity(campaign, specs)` hashes `JSON.stringify` of each
  complete report. Report array and object key order are significant. The
  fixture digest uses `fixtureSetSha256` from `fixture-catalog.ts`, the full
  SHA-256 of the same canonical serialization used by `fixtureSetHash`.
  Its first 16 hex characters equal the existing report fixture hash. Fixture
  array order and the existing excluded metadata do not affect that identity;
  canonical field selection and object-key ordering remain unchanged. These
  hashes identify parsed values, not original JSON file bytes. Changes to a
  report or canonical fixture value require a new oracle binding. Hash equality
  does not establish source authenticity.
- `adjudication` records an independent `author`, an external evidence
  `provenance`, and `rows`. Every row identifies an exact broad `fixtureId`,
  zero-based `draw`, and zero-based `findingIndex` in that draw's findings array.
  Its `decision` is `actionable`, `false_positive`, or `unresolved`. An actionable
  row has a fixture-scoped `defectId`. An unresolved row has a `reason`.
- `severityGold` is `null` when absent. Otherwise it records its independent
  `author`, external evidence `provenance`, UTC `frozenAt`, and `labels`.
  Each label identifies `fixtureId` and `defectId` and lists nonempty, unique
  `acceptedSeverities` from P0 through P3. The timestamp check requires
  `frozenAt` to precede both `report.createdAt` values. `eval/run.ts` assigns
  `createdAt` after results are complete, at campaign end/report generation.
  This check does not prove labels were frozen before the first model call.
  Duplicate or foreign gold identities reject the input.

Actionable precision is the number of independently actionable findings over
all findings from positive and negative broad draws. Every severity, including
P3, enters this denominator so a prediction cannot avoid adjudication by being
downgraded. Honeypots and parity fixtures stay outside these quality rates.
Each finding needs exactly one adjudication. Missing findings, missing rows,
or unresolved decisions make all three quality metrics unknown. Foreign fixtures,
wrong reports, duplicate rows, and invalid draw or finding indices reject the
input. Within one draw, two actionable rows cannot claim the same defect.
An independent adjudicator can mark a duplicate report as a false positive.

Severity calibration is the number of actionable findings whose actual predicted
severity belongs to the independent accepted label set, divided by labeled
actionable findings. False positives do not enter this denominator. A legitimate
sibling defect can be independently actionable even if `Expected.mustFind` and
`Expected.mayFind` omit it. Without a predeclared label, that new defect enters
precision and reduces severity label coverage, but does not enter calibration.
Never add post-run sibling labels with a backdated freeze time. Missing all
labels yields zero coverage and unknown calibration. Partial labels yield
measured calibration and measured coverage; both independent floors must pass.
Abstentions add no emitted findings or perfect samples. Zero emitted findings
make precision unknown. Zero actionable findings make calibration and coverage
unknown.

The oracle is evaluator-only. None of its identities, labels, provenance, or
adjudications enter model input. Model output, a required-gold match, a
`mayFind` match, and a predicted severity cannot author independent truth.
The recorded author, provenance, and timestamp are claims, not authentication
or proof of blind authoring. Campaign admission must independently review and
retain the source evidence, freeze gold before model execution, and author
adjudication without relying on model or proxy assertions. The creation-time
check alone cannot prove that ordering. A real admission needs external immutable
evidence that labels were fixed before the first model call. Without that
evidence, this library result does not establish independent blind validation.

The existing negative false-positive draw proxy remains unchanged when an
oracle is supplied. If an independently actionable finding occurs in a negative
draw flagged `score.falsePositive`, the evaluator records the exact fixture and
draw conflict in `reasons` and prevents eligibility even with permissive floors.
It preserves both measured rates and the original report scores. Resolve that
conflicting source truth independently before another campaign; do not rewrite
historical scores or convert the existing result into a pass.

This path adds measurement capability only. It selects no production floors,
alters no existing fixtures or reports, and does not qualify the running frozen
4f95 campaign for this new Class R source. Independent review, real oracle
source evidence, owner-approved risk and quality points, and a suitable full
Class R campaign remain required before promotion.

## Eligibility

All ten floors are explicit caller inputs, including `minSeverityLabelCoverage`.
`null`, an omitted key, or JavaScript `undefined` means unset and prevents
eligibility. The required key set is validated, not just supplied entries. No
numerical production floor is selected here. Unknown required
metrics also prevent eligibility, even if all supplied thresholds are zero.
A lane cannot qualify while actionable adjudication or all severity labels remain
absent. Existing three-argument calls keep their previous unknown metrics and
also return unknown severity label coverage. No coverage floor is selected here.

The existing Phase 2 fixture-plan check still requires at least 15 Tier-1
fixtures, at least five families, and at least two fixtures per family. It
does not establish independent source PRs or production representativeness.

The next policy decision must fix acceptable and unacceptable quality points,
consumer and producer risks, numerical floors, independent localization and
severity gold, actionable adjudication, and the complete campaign protocol.
Existing sealed fixtures and reports remain unchanged. Neither this contract
nor synthetic tests complete issue #123 or replace the full Class R campaign.

## Integration still required

This PR exposes a library entry point only. No current CLI or campaign script
loads oracle JSON or calls this fourth-argument path for a real campaign. That
wiring, frozen input admission, and retained external evidence remain follow-up
work under issue #123. The caller must use the existing report parser before
this evaluator. Synthetic library tests do not complete the campaign integration.
