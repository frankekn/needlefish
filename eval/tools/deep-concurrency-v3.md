# Execute the paired deep-concurrency study

`deep-concurrency-execute.ts` executes the registered 24-slot AB/BA schedule through production `review()`. It captures the two non-holdout fixtures once, including one campaign canary. All six replicates and both arms use those retained Git objects, bundle, patch, and base policy. Production review still creates its baseline and independent per-pass clones.

This is protocol `issue193-deep-concurrency-v3`. It preserves the complete v1 and v2 files and does not admit their historical source or lane as current evidence. It carries no observations or qualification from either version. No provider study has run for v3. Fake controls prove execution and accounting only.

## Bind execution before model use

The root coordinator must review the committed executor and bind its source, actual dependency inventory, native executable, Node, host, route, model-account exclusivity, and criteria before approving a new output directory. Do not run a real provider while another campaign shares its host or account.

Generate the source and Node identity with the intended checkout and Node executable.

```sh
node --import tsx eval/tools/deep-concurrency-execute.ts --identity > identity.json
```

Create a private admission file with these fields. Use the values from that identity and the actual native binary. `runnerVersion` is the exact output of its `--version` command. The native lane requires `codex-cli 0.163.0`, `gpt-5.6-terra`, and high effort. Its operator-attested route is OpenAI ChatGPT. The program rejects a configured proxy route. This is not independent provider identity proof.

```json
{
  "protocol": "issue193-deep-concurrency-v3",
  "operatorApproved": true,
  "exclusiveCapacity": true,
  "sourceCommit": "<40 hex characters>",
  "projectionSha256": "<64 hex characters>",
  "nodeSha256": "<64 hex characters>",
  "command": "/absolute/path/to/native/codex",
  "commandSha256": "<64 hex characters>",
  "runnerVersion": "codex-cli 0.163.0",
  "lane": "OpenAI-ChatGPT-native"
}
```

The `fake-offline` lane exists for the executable fake controls. It uses `fake-offline` as the model, admits the fake executable's version, and permits shorter timeout and retry settings. Those results cannot qualify the native lane. The native lane uses the unchanged v2 timeout and retry values.

Start the command in its own process group and retain its creation identity. Use a private, previously absent output directory outside the source checkout. The command refuses an existing directory and never resumes or replaces whole-review draws.

```sh
set -m
node --import tsx eval/tools/deep-concurrency-execute.ts --execute admission.json /private/study/new-campaign &
study_group=$!
ps -p "$study_group" -o pid=,pgid=,lstart=
wait "$study_group"
```

A terminal stop returns nonzero and preserves the executed prefix plus all 24 registered slots. Do not rerun an unchanged failed campaign for a better result. The v1 workload, fixed denominators, capacity, retry, safety, and promotion requirements still apply. V3 source and executable identities must match its own admission, rather than the historical source pin.

## Read the retained evidence

`report.json` contains all slots in registered order and keeps 12 planned reviews per arm. `NOT_STARTED_EARLY_STOP` has unavailable latency. A normal error or timeout remains in its slot and the schedule continues. Partial review and `needs_human` remain distinct from complete clean review. Completed underfill stops the campaign only after the whole review and process drain. Cancellation, source or native drift, evidence loss, or cleanup failure stops the campaign without replacement draws.

Each fixture has a private snapshot manifest and exact patch file. Its retained repository no longer has the materializer as a remote. The original fixture repository is deleted after capture. Every native attempt checks the actual snapshot head tree, base tree, patch, policy, and canary bytes against the capture. Mutating the captured baseline stops the campaign. Moving or deleting the original source cannot change later attempts.

Each slot contains these artifacts.

- `input.json`, `worker-birth.json`, and `supervisor-terminal.json` bind the actual review child and its supervised wall duration.
- `trace.jsonl` retains core pass index, prompt attempt, runner attempt, raw output, and outcomes.
- `progress.jsonl` records actual deep work completion, failure count, total work, and tail coverage.
- `attempts/<id>/` retains exact stdin, native stdout, stderr, output artifact, process birth, status, signal, and monotonic times.
- `attempt-index.json` retains native attempts and core provenance candidates matched using actual output bytes. It does not guess an association when repeated outputs are ambiguous.
- `workload.json` records observed hotspots and orders unambiguous topology by core pass index. A complete review with ambiguous topology is a method error. Different paired complete workloads stop with `WORKLOAD_MISMATCH`.
- `terminal.json` retains the actual ReviewResult, shared fixture score and anticheat result, partial state, or error.
- `capacity.jsonl` records counters before the review, once per second, and after the review. Capacity loss invalidates a timing conclusion.

The recorder forwards the original stdin, args, stdout, and stderr. Its native child remains in the process group owned by production core. It adds local recording overhead and changes the configured launcher into an instrumented launcher. Native timing and wrapper timing therefore remain separate. This instrumented study does not establish an unchanged native runtime qualification.

A hard kill can leave a started attempt without an end record. That is retained evidence loss and stops with a method error. Raw stderr mentioning `429` is not confirmed provider rate limiting. The report keeps that status unknown unless provider-owned structured status evidence exists. Core trace and native records remain separate where exact provenance cannot be resolved.

For a complete campaign, `pairedReviewTimings` retains all 12 `T7-T3` differences from monotonic review durations, plus their median, minimum, and maximum. It remains descriptive. Incomplete or mismatched campaigns have no paired summary.

The report deliberately makes no speedup or quality claim. Actual native process service time, monotonic review API time, supervised slot wall time, and campaign wall time have separate fields. A real study still needs every required attempt, matching seven-slot work, unchanged quality criteria, stable capacity, provider status evidence, and a measured limiter before an independent analyst can report timing conclusions. Neither this two-fixture study nor its tool controls satisfy a full Class R gate.

## Run the offline controls

Use the repository's Node version, timeout grace, serial test runner, and an external temporary directory. The tests execute production review and local fake processes. They make no provider calls.

```sh
TMPDIR=/private/owned-test-tmp NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS=100 \
  node --test --test-concurrency=1 --import tsx eval/tools/deep-concurrency-execute.test.ts
```

Set `NEEDLEFISH_PAIRED_TEST_EVIDENCE_DIR` to a new private directory to retain complete control campaigns. The controls cover all 24 slots, maximum in-flight 3 and 7, exact snapshot identity, underfill, errors, a synthetic 429, timeout, malformed output, partial review, `needs_human`, cancellation, captured source drift, and the top-level CLI. Fake timing is not provider performance evidence.
