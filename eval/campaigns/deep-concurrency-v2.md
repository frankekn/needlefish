# Deep concurrency v2 integration preregistration

This offline study is `issue193-deep-concurrency-v2`, `NOT_RUN`, and Class R.
It does not qualify a runner or change production concurrency.
No v1 or v2 model study has run. A full Class R gate remains required.

## Version identity

The source pin is `195db3e20baddf58c4206a98d12ae29f92084e3d`.
The current generator is `eval/tools/deep-concurrency.ts`.
The complete committed comparator is `eval/campaigns/deep-concurrency-v2.plan.json`.
The generator hashes itself, this document, and the inherited v1 protocol. It does not hash the comparator.
Its CLI rejects output that differs from the comparator before writing stdout.
Protocol, generator, configuration, or source drift blocks admission.
The source inventory and byte checks remain unchanged.

The integration requires explicit runner options for `reviewPlan()` and checks
its new capability result. These source and generator changes require a new
study identity. v2 carries no observations or qualification from v1.

All workload, lane, resource, snapshot, attempt, stopping, denominator, safety,
and reporting rules in [the v1 protocol](deep-concurrency-v1.md) apply to v2.
Its SHA-256 is `bf9db1343122abdd7e5e0956a5779bdbfc81ac610645e0820d45fc6f2f1e1d51`.
Only the source pin, study ID, generator identity, and comparator paths change.
The lane remains native Codex 0.163.0, `gpt-5.6-terra`, high, OpenAI ChatGPT.
CLIProxyAPI remains a separate lane. The two fixed non-holdout fixtures remain
`large-tail-boundary-bug` and `large-clean-sweep`, with 27 changed files each.
The arms remain 3 and 7, six replicates per fixture, 24 whole reviews, and
12 planned reviews per arm. Underfill still stops after a completed whole review,
retains every attempt, and marks remaining slots `NOT_STARTED_EARLY_STOP`.
No model executor is provided. Live execution and its fake adapter proof remain
unavailable. Model resources need separate authorization.

## Replay v2 before admission

Use a checkout whose frozen source files match the v2 source pin. Restore this
version's committed generator, protocol, and comparator into that checkout.
The generator rejects any different frozen source bytes or path inventory.
Run these commands before any separately authorized model execution.

```sh
study_plan_dir=$(mktemp -d)
pnpm exec tsx eval/tools/deep-concurrency.ts --plan > "$study_plan_dir/plan-a.json"
pnpm exec tsx eval/tools/deep-concurrency.ts --plan > "$study_plan_dir/plan-b.json"
cmp eval/campaigns/deep-concurrency-v2.plan.json "$study_plan_dir/plan-a.json"
cmp eval/campaigns/deep-concurrency-v2.plan.json "$study_plan_dir/plan-b.json"
```

The CLI accepts only `--plan`. Every other argument fails before fixture loading.
Resident tests check the current study data, schedule, disabled model execution,
and exact protocol hashes without freezing future main's production files.
Execution admission additionally requires the complete source and byte replay.

## Preserve v1

The v1 protocol and comparator retain their original bytes.
`deep-concurrency-v1.generator.ts.txt` contains the exact original generator
bytes. It is an archive, excluded from compilation and not an alternate runtime.
Its SHA-256 is `b9e140fb8814b1d724b2e53b147a56ea519d5c8af7a978339955a13c9e854c19`.
The v1 comparator SHA-256 remains
`c7f872f3293ebd7c94b8f9d51dc93ac30aac93b1d8f15e5544769d714f01a5fb`.
To verify historical v1, use its pinned source
`23a5912aa5938192b32231a0c17dadfe0b9d8320`, copy the archived generator bytes to
`eval/tools/deep-concurrency.ts`, and restore the unchanged v1 protocol and plan.
Then run the v1 replay commands. Current v2 output cannot be admitted as v1.
Never overwrite either version's comparator or attempt directory to admit drift.
