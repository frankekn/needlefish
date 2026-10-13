"""Verify the published metadata supplement without calling Muse."""
import hashlib
import json
from pathlib import Path

root = Path(__file__).parent
original_bytes = (root / 'original-report.json').read_bytes()
original = json.loads(original_bytes)
public = json.loads((root.parent.parent / 'results' /
    '2026-10-13-muse-code-wonder-1.0-high-ranked-x3.json').read_text())
attestation = public['publicEnvironmentAttestation']
assert hashlib.sha256(original_bytes).hexdigest() == attestation['sourceSha256']
changed = {'invocation', 'runnerEnvironment', 'privateEnvironment', 'publicEnvironmentAttestation'}
assert {k: v for k, v in original.items() if k not in changed} == {
    k: v for k, v in public.items() if k not in changed}
assert len(public['results']) == 261
assert len({(r['fixtureId'], r['draw']) for r in public['results']}) == 261
assert public['runnerVersion'] == 'Muse Code 1.4.7 (1.4.7-R6101.1)'
assert public['privateEnvironment'] is False
environment = dict(json.loads(public['runnerEnvironment']))
assert 'META_API_KEY' not in environment
assert '<required>' not in environment.values()
assert environment['NEEDLEFISH_ACP_AUTH_ENV_VARS'] == 'META_API_KEY'
for file, field in [('bridge-native.py', 'nativeBridgeSha256'),
                    ('bridge-recording.py', 'recordingBridgeSha256'), ('run.py', 'driverSha256')]:
    assert hashlib.sha256((root / file).read_bytes()).hexdigest() == attestation[field]
assert environment['NEEDLEFISH_ACP_BIN'] == 'sha256:' + attestation['recordingBridgeSha256']
calls = json.loads((root / 'transcript-manifest.json').read_text())['calls']
assert [c['call'] for c in calls] == list(range(1, 511))
assert all(c['completed'] and c['model'] == 'muse-wonder-1.0' and c['provider'] == 'meta' for c in calls)
assert sum(r['calls'] for r in public['results']) == 510
assert public['aggregates']['cheatDetectedCount'] == 0
assert public['aggregates']['recallByTier']['t1'] == 1
assert public['aggregates']['meanNoisePerPositive'] <= 0.12
print('Original bytes, unchanged experimental data, Muse Code identity and public metadata verified.')
