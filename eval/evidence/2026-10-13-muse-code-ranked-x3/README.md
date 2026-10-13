# Muse Code x3 execution evidence

The native harness is Muse Code 1.4.7, build `1.4.7-R6101.1`.
Needlefish's runner ID is `acp`. ACP is the transport between Needlefish and the
Python bridge, not the model harness. The bridge invokes local `muse exec` with
provider `meta`, model `muse-wonder-1.0`, and reasoning effort `high`.

## Original and public reports

`original-report.json` preserves the completed report bytes. Its SHA-256 is
`c4d16d512a3bc241b7de1fdb5fa3652b80b2eec909f0813248ad9273c6bd96c6`.
The public report in `eval/results/` changes only environment and invocation
metadata and adds an operator attestation. All findings, per-draw scores,
aggregates, execution and scoring identities remain unchanged.

The old harness labels ACP credentials, credential-variable names and local
executable paths as private. The public attestation removes the secret-value
placeholder, records the credential binding, names the auth variable and
identifies the executed bridge by SHA-256. `privateEnvironment: false` applies
to this public description, not to the untouched original report.
No credential value or credential digest is published.
Run `python3 eval/evidence/2026-10-13-muse-code-ranked-x3/verify.py` to verify
the original bytes, unchanged experimental data and public identity metadata.

## Execution records

- `bridge-native.py` is the exact native bridge executed by the recording bridge.
- `bridge-recording.py` and `run.py` preserve the executed temporary scripts.
  Their absolute paths describe the original run, not a portable installation.
- `PLAN.md` preserves the predeclared scope, limits and ranking criteria.
- `transcript-manifest.json` contains hashes for all 510 stdout and stderr
  records. Each stdout includes one Meta Wonder configured-model event and a
  completed ACP response. Raw transcripts remain private.

The supervisor heartbeat and per-call exit metadata stopped updating mid-run.
The eval subprocess continued and wrote all 261 unique draw slots. Completion
is checked from the final report and all 510 completed responses, not stale
heartbeat or missing exit metadata. This limits the claimed live stop coverage
after the supervisor ended. No failed ACP response, invalid output,
operational failure or structured bait adoption appears in the saved results.
The 41 raw bait exposures remain recorded separately.

Configured-model events identify Meta and Wonder, but contain no effort field.
High effort is operator-attested from the native bridge's fixed command line.
Transcript hashes establish file identity, not independent access to raw text.

## Reproduction

Use execution commit `a5a0c6874a5f2a6e3c47b41ee39ca6af5e8e2d92` and its pinned
dependencies. Install and authenticate Muse Code 1.4.7 separately.
Set `META_API_KEY` in memory. Do not place it in command arguments or report files.
Set `NEEDLEFISH_ACP_BIN` to the absolute path of `bridge-native.py` and set
`NEEDLEFISH_ACP_AUTH_ENV_VARS=META_API_KEY`.
Run the public report's `reproductionCommand` from the frozen checkout.
The command requires 510 model CLI calls in this completed run. Internal API
requests and quota charges are not measured by that count.
