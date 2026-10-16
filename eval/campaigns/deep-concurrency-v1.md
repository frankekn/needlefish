# Deep concurrency 7 versus 3 preregistration

This is an offline study protocol for issue #193 U6. The study is `NOT_RUN`.
It does not qualify a runner, change the default of 3, or satisfy the full
Class R eval gate. `gateClass: R` identifies the applicable promotion contract.
A successful timing study still needs that full gate before a production change.

## Freeze the plan

Run `pnpm exec tsx eval/tools/deep-concurrency.ts --plan > plan.json`.
The command only checks local files and creates temporary fixture Git repos.
It cannot execute a model. Every other argument, including `--run`, fails.
Commit the plan digest and execution identity before the first study call.
Use a new output directory. Never overwrite prior attempts or resume a report
from another campaign. A changed source, lane, protocol, or dependency requires
a new study ID and prior approval to use model resources.

The source is `23a5912aa5938192b32231a0c17dadfe0b9d8320`. The checker compares
all `src`, prompts, shared eval code, `eval/run.ts`, root `tsconfig*.json` files,
package manifest, lockfile, and both selected specs byte for byte against this
commit. It also freezes the root `tsconfig*.json` path set, including
`tsconfig.json` and `tsconfig.build.json`. It rejects added or deleted configs,
config paths that are not regular files, and added files or symlinks in the
frozen directories. It records SHA-256 digests,
the existing prompt hash and fixture-set hash, and each generated patch digest.
The plan also hashes this protocol and the plan generator itself.
It imports only the two explicitly named non-holdout specs. It does not load
the full catalog or inspect sealed holdout contents.

The paired `large-tail-boundary-bug` and `large-clean-sweep` fixtures are the
existing defect and clean versions of a logger migration. Each changes 27
files and takes the production large path without forced `--deep`. This is
a narrow workload study, not representative evidence across repositories.

The fixed lane is native Codex CLI 0.163.0, `gpt-5.6-terra`, high effort,
OpenAI, ChatGPT subscription. CLIProxyAPI is a separate lane and is not a
substitute. Before execution, record the actual binary and Node SHA-256,
versions, dependency inventory, OS, host identity, and operator-attested route.
Do not archive credentials. Reject an unexpected model, provider, version,
proxy route, missing identity, or source drift before starting a slot.

## Execute the fixed pairs

The generated schedule has six replicates of each fixture, 12 pairs and 24
whole reviews. Each pair runs 3 and 7 serially against the same captured
fixture snapshot. Materialize each fixture once with `loadFixture` and one
campaign canary, then retain its exact base/head commits, trees, patch, and
policy for all replicates. Use the existing throwaway per-call clone and
integrity checks. Fresh Git timestamps or a new canary must not change that
snapshot between arms. The next pair starts only after both reviews drain and all
owned processes exit. Order alternates AB and BA within each fixture. Each
fixture has three pairs starting with each arm. There is no warmup or excluded
first draw. No other review campaign may share this host or account during
execution. In particular, do not overlap the active #256 campaign.

Reuse production `review()` and the shared eval scorer, trace, anticheat, and
report contracts from `eval/run.ts`. The eventual execution adapter must pass
the captured bundle to each slot with outer review concurrency 1. Do not call
`eval/run.ts` separately per slot because it creates fresh snapshots and
canaries. Adapter implementation and its fake integration check remain an
execution prerequisite; this PR supplies no live executor. Use the plan's
explicit lane identity and environment, changing only
`NEEDLEFISH_DEEP_CONCURRENCY` between the pair. Reports use `gateClass: R` and
only these two non-holdout fixtures. This subset cannot be a full-contract
baseline. Keep normal internal transport
and malformed-output retries. Their extra calls are observations, not replacement
draws. Capture every native process attempt, stdout, stderr, exit status,
prompt attempt, runner attempt, pass kind and index, and start/end timestamps.
Use a private evidence directory. Never publish raw transcripts without screening.

Before every review, require at least eight cores, load1 below half the core
count, normal memory pressure, and exclusive model capacity. On macOS, normal
pressure is `kern.memorystatus_vm_pressure_level=1`. On Linux it is memory PSI
`full avg10=0`. Record counters before, every second during, and after each
review. Wait at most 30 minutes before starting a slot. Capacity loss during
a slot invalidates the campaign's timing conclusion. Preserve the slot and
all evidence. Do not restart it when capacity improves.

Start the supervisor and every native runner in owned process groups. Record
PGIDs and creation identities. On cancellation, kill each owned group, reap
it, and verify no members remain. Do not stop unrelated groups or the #256
campaign. An unclean process-group exit stops the study as incomplete.

Per-call timeout is 20 minutes. Whole-review monotonic deadline is 30 minutes.
The campaign stops after 24 hours, cancellation, a safety/cheat signal, source
or lane drift, lost evidence, or failed process cleanup. A 429, ordinary runner
error, timeout, or `needs_human` stays in its slot and the schedule continues
within these fixed limits. A deadline stop preserves running and not-started
slots. Do not add draws, reorder slots, retry a whole review, or replace a
failed campaign with an unchanged rerun selected for a better score.

## Keep work and denominators visible

Record the selected ordered hotspots, file membership, tail coverage, and every
attempt for both arms. A valid equal-work timing comparison requires exactly
seven deep slots in each review and identical ordered hotspot/file membership
within every pair. Map and critic must each complete once, with no skipped
changed file. If any pair differs, report `WORKLOAD_MISMATCH` and no 7-versus-3
speed conclusion. Do not discard that pair and summarize the remaining ones.
Do not force maps, change prompts, or add calls to repair a mismatch.

The planned denominator is 12 whole reviews per arm. The initial successful
call budget under the required topology is 108 per arm, one map, seven deep,
and one critic per review. Actual attempts need not be equal because failures
and retries are outcomes. Report actual attempted calls, successful calls,
retry calls, and absent/not-started work separately for each arm. A claim of
equal total actual calls requires observed equality; never infer it from the
schedule. A campaign with unequal work or attempt counts cannot establish
an equal-call speedup.

Primary latency is monotonic time from entry to whole-review terminal outcome,
including setup inside that interval, map, deep, internal retries/backoff,
critic, and failures. Supervisor wall time additionally includes fixture setup,
cleanup, and capacity waits. Record both and never substitute summed per-call
durations for wall time. Report all 12 slots per arm in schedule order, with
completed, timeout, error, and not-started states. Report timeout as censored
at its elapsed deadline and not-started latency as unavailable. Never assign
zero latency to either. The completion denominator stays 12.

For a complete equal-work campaign, report all paired differences `T7-T3`,
median difference, and min/max. Also report success-only latency, explicitly
as a secondary denominator with its count. A successful review means complete
map/deep/critic and valid artifact delivery; a legitimate blocking verdict is
still a completed review. Report verdict distribution and `needs_human/12`.
Report 429-affected reviews/12, 429 native attempts/all native attempts,
timeout reviews/12, operational failures/12, malformed output, safety signals,
and quality metrics using the existing scorer. Keep failures even if an
internal retry later succeeds. A text-only mention of 429 is not a provider
rate-limit observation; retain provider-owned status evidence or mark unknown.

No speedup claim is valid without matching work, all 24 terminal outcomes,
complete attempt evidence, stable host capacity, and a measured limiter.
Record CPU, memory pressure, process counts, and provider queuing/rate limits
to distinguish concurrency savings from saturation or skipped work. If the
limiter cannot be established, report descriptive timings with that limit.
This small study does not choose a new default automatically.

## Verify the offline artifact

Run `node --test --import tsx eval/tools/deep-concurrency.test.ts`.
The test calls the real production `review()` using a local fake Codex process.
Its map creates six distinct hotspots and leaves a tail. A barrier proves that
three and seven deep jobs can be in flight respectively, all seven drain,
and each arm runs nine successful calls before the critic finishes. These
fake events prove scheduling and call accounting only. Their durations,
verdicts, and absence of provider errors are not model performance evidence.
