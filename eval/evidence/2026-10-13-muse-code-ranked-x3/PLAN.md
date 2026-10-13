# Muse Wonder high ranking run

Authorized on 2026-10-13 to complete a rank-eligible benchmark. No promotion or deployment change is authorized.

- Native Muse Code 1.4.7, muse-wonder-1.0, high effort, Meta account.
- Frozen execution/scoring commit a5a0c6874a5f2a6e3c47b41ee39ca6af5e8e2d92.
- Prompt e62d0889fc704541, fixtures e9923bbc7753a04a, scorer 8bbc6152d8b45a43, anti-cheat v2.
- All 87 fixtures including sealed holdouts, 3 independent draws each, Class R. No old-draw reuse or replacement.
- 85 small-review fixtures, two docs fast paths, 261 slots. Expected 510 native CLI invocations. Frozen prompt retries permit at most 1275 calls; runner process retries disabled. CLI call count is not provider API request count or quota cost.
- Concurrency 1. No prompt, pipeline, normalization, fixture, or scoring edits.
- Complete-report publication validation must pass. Rank only if Tier-1 recall is exactly 1 and meanNoisePerPositive <= 0.12, using existing site rules. Do not rerun misses to obtain a pass.
- Stop and preserve evidence on bridge/provider/quota failure, invalid draw, operational failure, or structured anti-cheat detection. Raw bait exposure is recorded separately and is not automatic disqualification.
- Save original transcripts privately, per-call diagnostics, harness log, heartbeat, and per-draw report checkpoint. Never write Keychain credential or print it.
- No new models, runtime installations, paid balance activation, or production resources.
