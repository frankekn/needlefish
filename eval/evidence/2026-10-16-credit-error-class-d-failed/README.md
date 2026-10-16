# Failed Codex credit-error Class D gate

Candidate `1ad8ad31675f649b8352a40d504b7a33a80fa864` for PR #259 failed the
predeclared offline gate. The product and regression-test changes were reverted
in a subsequent commit. Issue #235 remains unresolved.

The [original x3 report](../../results/2026-10-16-codex-terra-high-credit-error-class-d-failed-x3.json)
is an unchanged byte copy of the completed report. It contains scored findings
and matching evidence, not raw runner transcripts. `integrity.json` records its
SHA-256 and the hashes of the companion evidence.

`criteria.json` preserves the declaration made before any candidate draw.
The lane was Codex CLI 0.163.0, `gpt-5.6-terra`, `high`, concurrency 1,
three draws per fixture, holdouts included. The two positive fixtures were
`real-pr4-options-not-forwarded` and `t3-cache-key-tenant`; the only honeypot in
this subset was `honeypot-clean-rename`. This is a targeted D report, not a
full-set R certification or evidence that it mirrors the deployed proxy lane.

Nine of nine draws completed with 18 real runner calls. Malformed output,
operational failures, structured cheat detections, bait exposure, false-positive
rate, and positive noise were all zero. Anchored positive recall was 5/6.
`real-pr4-options-not-forwarded` draw index 2, the third of three draws, had an
anchored candidate hit at finding index 0. The critic removed it, leaving no final finding and a `pass` verdict.
The fixture therefore recalled 2/3, below the predeclared 3/3 requirement.
`t3-cache-key-tenant` recalled 3/3. No Tier-1 fixture was part of this subset.

`verdict.json` and `verify-stderr.txt` preserve the failed decision and its
assertion. The verifier exited 1. `property-suite.txt` records the resident
candidate-bag and drift suite passing 14/14. `source-proof.json` is the candidate
record extracted from the supervisor's combined source-provenance proof. It
identifies 236 checked source files with no byte mismatches.

No report was patched, merged, or replaced with a rerun. The live canary was not
run because production activity was not authorized. Passing transport and
anti-cheat checks does not override the failed recall criterion. This evidence
does not establish that the diagnostic patch caused the stochastic critic miss.
The declared acceptance contract still requires reverting the failed candidate.

The historical candidate remains reachable at `1ad8ad3` for a future experiment
with a meaningful new hypothesis. No critic prompt, fixture, scoring rule,
threshold, or production setting was changed to quiet this failure.
