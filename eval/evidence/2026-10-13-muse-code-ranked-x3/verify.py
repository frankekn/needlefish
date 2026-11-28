"""Verify the published metadata supplement without calling Muse."""
import hashlib
import json
from pathlib import Path

if not __debug__:
    raise RuntimeError('Verification requires Python assertions. Run without -O or PYTHONOPTIMIZE.')

root = Path(__file__).parent
original_bytes = (root / 'original-report.json').read_bytes()
original = json.loads(original_bytes)
public = json.loads((root.parent.parent / 'results' /
    '2026-10-13-muse-code-wonder-1.0-high-ranked-x3.json').read_text())
attestation = public['publicEnvironmentAttestation']
assert hashlib.sha256(original_bytes).hexdigest() == attestation['sourceSha256']
changed = {'invocation', 'runnerEnvironment', 'privateEnvironment', 'publicEnvironmentAttestation',
           'reproductionCommand'}
# 2026-11-28 offline rescore against the corrected holdout-pagination-round-down
# answer key (eval/RESULTS.md). Only that fixture's score and evidence fields,
# the recall-dependent aggregates and fixtureSetHash may differ from the original.
RESCORED = 'holdout-pagination-round-down'
RESCORED_SCORE = {'mustFindHits', 'recall', 'lineAnchorValid', 'noiseFindingCount'}
RESCORED_AGGREGATES = {'recall', 'lineAnchorValidRate', 'recallByFixture', 'mustFindHitRateByFixture',
                       'mustFindHitRate', 'recallByTier', 'recallByDefectClass',
                       'lineAnchorValidRateByDefectClass', 'meanNoisePerPositive', 'criticPrunedRecallCount'}


def frozen(report):
    out = {k: v for k, v in report.items()
           if k not in changed | {'results', 'aggregates', 'fixtureSetHash'}}
    out['results'] = [
        r if r['fixtureId'] != RESCORED else {
            **{k: v for k, v in r.items() if k not in {'score', 'matchEvidence', 'candidateMatchEvidence'}},
            'score': {k: v for k, v in r['score'].items() if k not in RESCORED_SCORE},
        }
        for r in report['results']]
    out['aggregates'] = {k: v for k, v in report['aggregates'].items() if k not in RESCORED_AGGREGATES}
    return out


assert frozen(original) == frozen(public)
# The rescore replaces final evidence and removes stale candidate evidence; enforce that shape.
for o, p in zip(original['results'], public['results']):
    if p['fixtureId'] != RESCORED:
        continue
    assert 'candidateMatchEvidence' not in p, (p['fixtureId'], p['draw'])
    if 'matchEvidence' in o:
        evidence = p['matchEvidence']
        assert isinstance(evidence, list) and len(evidence) == len(o['matchEvidence'])
        for item in evidence:
            index = item['findingIndex']
            assert index is None or (isinstance(index, int) and 0 <= index < len(p['findings']))
        assert p['score']['recall'] == all(item['findingIndex'] is not None for item in evidence)
assert original['fixtureSetHash'] == 'e9923bbc7753a04a'
leaderboard = json.loads((root.parent.parent / 'leaderboard.json').read_text())
baseline = json.loads((root.parent.parent / leaderboard['baseline']).read_text())
assert public['fixtureSetHash'] == baseline['fixtureSetHash']
assert len(public['results']) == 261
assert len({(r['fixtureId'], r['draw']) for r in public['results']}) == 261
assert public['runnerVersion'] == 'Muse Code 1.4.7 (1.4.7-R6101.1)'
assert public['privateEnvironment'] is False
environment = dict(json.loads(public['runnerEnvironment']))
assert 'META_API_KEY' not in environment
assert '<required>' not in environment.values()
assert environment['NEEDLEFISH_ACP_AUTH_ENV_VARS'] == 'META_API_KEY'
assert environment['NEEDLEFISH_RUNNER_ENV_PASSTHROUGH'] == 'META_API_KEY'
assert public['reproductionCommand'] == original['reproductionCommand'].replace(
    'NEEDLEFISH_RUNNER_ENV_PASSTHROUGH=META_API_KEY --draws',
    'NEEDLEFISH_RUNNER_ENV_PASSTHROUGH=META_API_KEY,NEEDLEFISH_MUSE_BIN --draws')
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
