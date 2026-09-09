# Code-review qualification rollout

This plan defines the work that must be complete before the next model eval campaign. It does not authorize or trigger model runs.

## Official DeepSWE harness

DeepSWE v1.1's official harness is Pier. The environment is pinned to the latest published release at the time of this campaign:

```bash
uv tool install --upgrade datacurve-pier==0.3.1
pier --version  # 0.3.1
```

This installs the harness only; it does not start a benchmark run. Record the resulting Pier version in every campaign report.

Local authentication is configured through `~/.local/bin/pier-deepseek`.
It reads the existing `cliproxy-deepseek` provider and client credential from
the local Pi configuration, then passes them to Pier in process environment
variables. No credential is stored in this repository. The launcher pins
`openai/deepseek-v4.1-flash-expires-on-0910` for the proxy's OpenAI-compatible
transport; the underlying model ID remains `deepseek-v4.1-flash-expires-on-0910`.

`pier-deepseek --check` verifies authentication and exact model availability
using only the model catalog. This check and `pier-deepseek --version` passed
locally on 2026-09-09. Inference and container connectivity have not been tested.
Pier is the DeepSWE benchmark harness; this setup does not replace Needlefish's
existing Pi review runner or change historical reports.

## Planned lane matrix

- GPT-5.6 Terra: Codex, `xhigh`, OpenAI Codex subscription.
- `deepseek-v4.1-flash-expires-on-0910`: Pi, `max`, through the managed CLIProxyAPI route.
- GLM-5.3-Flash: currently blocked because the Z.AI provider quota is exhausted. Do not run a partial or reduced campaign for this lane; revisit it only after quota availability is confirmed.

The machine-readable source for this matrix is `eval/campaigns/code-review-v1.json`. Historical leaderboard entries remain unchanged until a complete, comparable report exists.

## Protocol

- Version the policy as `code-review-v1`.
- Freeze lane identity, grader, prompt hash, fixture set hash, resource limits, draw counts, and thresholds before execution.
- Run a broad campaign at three draws per fixture and a deep campaign at six draws for the selected Tier-1 set.
- Treat the fixture/PR as the sampling unit when describing uncertainty; repeated draws are correlated observations.
- Keep holdouts sealed during iteration and include them in the final campaign.

## Required evidence

- Tier-1 recall by fixture and defect family.
- Actionable precision and blocking noise per positive review.
- File/line localization accuracy by family.
- Severity calibration and critical-miss list.
- Fixture-weighted descriptive `pass^k`.
- All draw outcomes, retries, spend, latency, lane identity, and protocol hashes.

## Qualification gates

The interim gate is 20/21 Tier-1 successes, at least 2/3 per fixture, and positive noise ≤ 0.12.

The Phase 2 gate is 86/90 Tier-1 successes, at least 4/6 per fixture, plus calibrated family recall, localization, precision, and noise floors. Family and precision thresholds remain unset until calibration defines acceptable and unacceptable quality points; they must not be guessed from one campaign.

Composite score ranks only lanes that pass every hard gate. A composite gain cannot compensate for a critical miss or a family blind spot.

## Pre-run checklist

- [ ] Add and review the new Tier-1 fixtures under defect-family quotas.
- [ ] Verify every fixture has an independent verifier, anchor, tier, family, provenance, and holdout status.
- [ ] Freeze policy, prompts, grader, runner versions, and resource settings.
- [ ] Validate expected campaign cost and provider capacity.
- [ ] Run static checks and unit/property tests.
- [ ] Record the exact campaign command before starting any lane.

## Post-run decision

Do not change the production qualification gate from interim to Phase 2 until the full Class R report passes comparability, anti-cheat, holdout, recall, precision, localization, and consistency checks. Diagnostic reruns cannot alter qualification.
