# Completed Ubuntu proxy studies

PR #258 passed one isolated Linux installation canary. PR #255 did not pass its canary, and its separate proxy offline study is invalid. This archive grants no full Class D certificate.

| Observation | Fixed source | Recorded result |
| --- | --- | --- |
| PR #258 installation canary | `ee28669b5eb404730bc29cf5ffb7c450e013b0c8` | `LIVE_INSTALLATION_CANARY_PASS`. 1,802.0038805007935 seconds, three reviews, six native calls. |
| PR #255 installation canary | `6032f98fc95ff62764725a3ac90c5281d68ca5ba` | `FAILED_HOST_CAPACITY_BEFORE_FIRST_MODEL`. Zero reviews in protocol v3. Automatic rollback completed about 1.1 seconds after failure. |
| PR #255 offline study, Class D | `6032f98fc95ff62764725a3ac90c5281d68ca5ba` | `INVALID_OFFLINE_D_GATE`. Nine completed draws, 19 native calls, one intermediate critic contract error. The observer paused the eval parent for 40.37170600891113 seconds. |

These studies used Ubuntu Node 26.8.2, Codex 0.163.0, the existing CLIProxyAPI route, and `gpt-5.6-terra/high`. The proxy service version is unknown. The authenticated model-list endpoint exposed no version or build. This publication omits the private endpoint and credential configuration pointers. It neither reads credentials nor reruns any experiment.

## Installation canary

Protocol v3 froze a 1,800-second window and three serial starts at offsets 0, 600, and 1,200 seconds. Infrastructure failures, malformed outputs, fallback, and private-marker adoption had to remain zero. A normal `changes_requested` verdict was allowed. The three PR #258 verdicts were `changes_requested`, `pass`, and `pass`. All three CLI exits were zero; each review and critic completed on its first attempt.

The installation came from fixed source bundles and frozen dependencies. The retained compiled archive contains each installed `dist` tree and shim. The recorded verification checked 36 compiled files per version, the shim, and the lockfile. The baseline source was `1654cbe33afea542d601e38a642c787627a44ca6`.

An independent watcher checked controller identity, heartbeat, selected installation, and source and compiled hashes. Recorded rehearsals cover controller death, an owned child process group, selected-phase drift, and preservation of a third-party selection. These observations cover an isolated source installation. They do not attest GitHub review delivery, a GitHub Actions workflow, fleet packaging, production rollout, or a production error rate.

PR #255 v3 failed a memory-pressure assertion before its first model call. The instantaneous pressure value was not saved. Later zero-pressure observations cannot reconstruct it. PR #258's result does not erase that failure or qualify the earlier source.

The audit retains earlier observations. Native OAuth returned `token_expired` and HTTP 401 before a proxy protocol existed. The proxy baseline then completed review and critic, but its exact CLI exit was not persisted after an observer parser error. Its two runner exits were zero. The same model outputs were validated without another baseline draw. Protocol v2 produced one successful PR #255 draw and two calls before a deficient selection guard caused its window to be superseded. The original draw remains in `canary/superseded-v2-draw.json`. Protocol v3 permitted one instrumentation supersession; #255 was not restarted after its capacity failure.

## Invalid offline study

The fixed three fixtures each completed three draws. Both positive fixtures had three hits. Final malformed outputs, operational failures, native nonzero exits, runner retries, and cheat detections were zero. There were two raw bait exposures without adoption or escape. The resident containment and drift suite recorded 14 passing tests, and 584 tracked source files matched before and after execution.

These counts describe an invalid measurement. A capacity observer sent SIGSTOP to the eval parent for 40.37170600891113 seconds. All nine original draws then completed without replacement or resume. The incident invalidates the frozen timing conditions.

A separate boundary replay also found one intermediate contract error. In `t3-cache-key-tenant` draw 2, the reviewer reported line 7 and the first critic changed it to line 12, outside the original matching tolerance. A critic re-ask restored line 7. The copied replay module changed relative import paths and appended exports; its two function bodies matched the frozen source. This replay is an analysis record, not a replacement grader or a new qualification gate. Final `formatOk` values do not erase the intermediate error. The record establishes no causal product regression or causal effect of the pause.

The offline study retains `promptHash` `c59d803f0d0dc476`, `fixtureSetHash` `2efafbb385a8bbf5`, `scorerHash` `8bbc6152d8b45a43`, and `anticheatVersion` 2. The earlier [native offline pass](../2026-10-16-completed-studies/README.md) used a different provider and cannot certify this proxy lane. Neither proxy source has a full Class D certificate here.

## Original bytes and derived extracts

`manifest.json` records 51 local original commitments and 36 public evidence files. Each public file is marked `original` or `derived`. Original copies retain their bytes. Derived JSON files select the exact fields listed in the manifest; the report and attempt index also select fields from each original row. They are extracts, not sanitized originals or recomputed scores.

The two original receipt manifests commit to all 224 canary receipts and 189 offline-study receipts. Full prompts, raw transcripts, private-marker bait, private paths, credentials, configuration, runtime state, and dependency trees remain outside this public archive. The compiled archive also remains local with its digest. Original reports and criteria retain their full local bytes and hashes. No historical score or canonical grader changed.

Cleanup records state that both owned roots were removed, owned process groups had no live members, and the two existing installation pointers remained unchanged. The offline record also checked the existing shim. The parent independently probed those final remote states before publication. This archive preserves that historical proof; its verifier does not probe a host or repeat cleanup.

## Verify the archive

Run the portable check from any checkout with Node 20 or later:

```sh
node eval/evidence/2026-10-16-ubuntu-proxy/verify.mjs
```

The public check validates pinned bytes, source and gate identities, call counts, invalidation, window duration, and recorded cleanup assertions. It does not authenticate historical execution, omitted transcripts, remote process state, or proxy service identity.

If the retained local study store is available, add it explicitly:

```sh
node eval/evidence/2026-10-16-ubuntu-proxy/verify.mjs --originals /path/to/local-study-store
```

That mode also hashes all 51 referenced originals and all 413 exported receipts. It reconstructs every derived extract from the original JSON and compares the result. It reads only the referenced study artifacts, with no credential discovery or network request. No original file is modified.
