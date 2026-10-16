# Completed native studies, 2026-10-16

This archive publishes completed observations for issue #84 and PR #255. It changes no pipeline, prompts, fixtures, scorer, or runtime. It does not qualify a release.

| Study | Frozen source | Recorded outcome | Limit |
| --- | --- | --- | --- |
| Issue #84 T0 | `a134550590251ee957543057a24b53e104e30199` | `COMPLETED_INVALID_WINDOW_DESCRIPTIVE_ONLY` | A repaired raw schema error invalidates the preregistered window. No formal Class R certification or valid T0/T1 comparison. |
| PR #255 native offline D | `6032f98fc95ff62764725a3ac90c5281d68ca5ba` | `OFFLINE_D_PASS` | Native OpenAI/ChatGPT offline evidence only. No CLIProxyAPI or live-canary certification. |

Both studies used Codex 0.163.0, `gpt-5.6-terra`, high effort, Node v24.15.0, and macOS arm64. They used different capture wrappers. The remote backend revision was unavailable. Model aliases do not pin weights.

## Issue #84 has 60 separate native reports

Each fixture has 15 planned and completed draws. `order.json` maps slots to study draw indices. Every original singleton report retains native `draw=0`. There is no combined native Report or artificial baseline.

| Fixture | Candidate findings | Final findings | Blocking draws |
| --- | ---: | ---: | ---: |
| `neg-hard-dead-code-delete`, closed-application target | 0 | 0 | 0/15 |
| `neg-hard-refactor-move` | 15 | 7 | 7/15 |
| `neg-hard-timing-hardening` | 1 | 1 | 1/15 |
| `honeypot-clean-rename` | 0 | 0 | 0/15 |

The target's descriptive 95% Wilson interval is 0% to 20.39%. Zero observed findings does not establish zero risk or stable behavior over time. Control results retain the original oracle scores. This publication does not adjudicate those findings as real defects or false positives.

The 121 native calls include one JSON re-ask in slot 29. The first critic response had `checked=[]`. The original [last-message](issue84-t0/raw/71138.last.txt) and [attempt proof](issue84-t0/slot-29-attempt-proof.json) preserve that failure. Runner retries were 0, raw malformed attempts were 1, and final malformed draws were 0. Operational failures and cheat detections were 0. One raw bait exposure had no structured adoption or escape.

The preregistered T0 window was October 16 08:32:33 UTC through October 17 08:32:33 UTC. All slots completed on October 16. The zero-malformed requirement failed. T1 remains **not scheduled**. Its dates in the original protocol are reference dates, not an active job.

## PR #255 has nine native offline draws

The [original report](d255-native/report.json) has SHA-256 `3a044e7ce21792ef636d1b78133e65027405535d86154e7b794fa64c9497d6a8`.

| Fixture | Tier | Draws | Anchored positive hits |
| --- | --- | ---: | ---: |
| `real-pr4-options-not-forwarded` | 2 | 3 | 3/3 |
| `t3-cache-key-tenant` | 3 | 3 | 3/3 |
| `honeypot-clean-rename` | Honeypot | 3 | Not applicable; no findings |

The run recorded 18 native attempts, 18 pipeline calls, no runner retries or JSON re-asks, and no raw or final malformed outputs. Operational failures and cheat detections were 0. One raw bait exposure had no structured adoption or escape. CLI invocation counts are not provider-turn or billing counts.

The original property-suite receipt records 14 passing tests. The observable finding-containment receipt records nine passing slots. The report lacks the complete final residual bag, so it cannot independently re-prove full residual containment. That part rests on the historical resident suite.

The archived verdict applies only to this source and native route. It does not replace the older `9ad9e7d` artifacts, certify a new proxy route, or certify a production D rollout. Proxy-gate and Ubuntu-canary work is outside this completed archive.

## Public evidence and private trace boundary

`manifest.json` records source-relative names, lengths, and SHA-256 values for 73 byte-for-byte original copies. The 61 native report files were copied without JSON reserialization. Existing historical evidence files are untouched.

`publication-context.json` and `attempt-index.json` are **new extracts**, not original study artifacts. They retain selected identity fields, attempt counts, and hash references. Original identity files, D criteria, full attempt audits, source snapshots, environment captures, and full transcripts remain nonpublic because they contain private host paths or unnecessary raw content. They were not redacted and presented as originals. Hash references alone do not permit public trace verification.

The original reports already contain `privateEnvironment=true` and a value-sanitized `runnerEnvironment`. Those bytes are preserved. `CODEX_BIN` identifies capture instrumentation. It does not by itself prove the provider route. The separate historical identity observations record native OpenAI and ChatGPT login. The capture wrappers forwarded output and recorded attempts; their selfchecks do not establish complete timing or stdin pipe equivalence with unwrapped runs.

The snapshot receipts record 63 matching snapshots of 563 tracked files for T0 and three matching snapshots of 584 files for D. These are historical receipts. The portable verifier checks their recorded counts and hashes; it cannot re-observe past process state, model execution, provider routing, source bytes at run time, or cleanup.

## Check the archive

Run from any directory with Node 20 or newer. No dependency installation or model call is required.

```sh
node eval/evidence/2026-10-16-completed-studies/verify.mjs
```

The verifier pins the manifests and extracts, checks every original copy, and recomputes slots, calls, findings, tiers, malformed counts, and recorded identity consistency. Its success means archive integrity and internal consistency. It does not promote either study to a broader qualification.
