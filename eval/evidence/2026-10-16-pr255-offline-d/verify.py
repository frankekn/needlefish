"""Check the frozen offline D evidence without running a model."""
import hashlib
import json
import subprocess
from pathlib import Path

if not __debug__:
    raise RuntimeError('Run without -O or PYTHONOPTIMIZE to enable assertions.')

evidence = Path(__file__).resolve().parent
repo = evidence.parents[2]
manifest = json.loads((evidence / 'manifest.json').read_text())
source = '9ad9e7d829f3d70e64d4230bd166dbaa2c399309'
assert manifest['sourceSha'] == source
tracked = set(subprocess.check_output(['git', 'ls-files'], cwd=repo, text=True).splitlines())
assert {item['path'] for item in manifest['files']} <= tracked
for item in manifest['files']:
    assert hashlib.sha256((repo / item['path']).read_bytes()).hexdigest() == item['sha256'], item['path']
report_bytes = (repo / 'eval/results/2026-10-16-pr255-9ad9e7d-offline-d-x3.json').read_bytes()
assert hashlib.sha256(report_bytes).hexdigest() == 'e0f8c545be08000aa3e91076bcb933b5c687e205dde9ccfa9b838ea1ea0daf8e'
report = json.loads(report_bytes)
criteria = json.loads((evidence / 'criteria.json').read_text())
verdict = json.loads((evidence / 'verdict.json').read_text())
proof = json.loads((evidence / 'source-proof.json').read_text())
assert criteria['candidateSha'] == verdict['gitSha'] == report['gitSha'] == proof['sha'] == source
assert criteria['gateClass'] == report['gateClass'] == 'D'
assert criteria['declaredAt'] < report['createdAt']
assert verdict['status'] == 'OFFLINE_D_GATE_PASS'
assert verdict['liveCanary'] == 'PENDING_NOT_AUTHORIZED'
assert (report['runner'], report['model'], report['effort']) == ('codex', 'gpt-5.6-terra', 'high')
assert criteria['runnerVersion'] == verdict['runnerVersion'] == 'codex-cli 0.163.0'
assert report['draws'] == criteria['draws'] == 3
assert report['holdout'] == criteria['holdout'] == 'include'
assert report['privateEnvironment'] is False
assert dict(json.loads(report['runnerEnvironment'])) == {
    'NEEDLEFISH_EPHEMERAL_HOME': '1', 'NEEDLEFISH_EVAL_TRACE': '1',
    'PATH': 'sha256:9e165915f29e07f6',
}
assert report['fixtureSetHash'] == verdict['fixtureSetHash'] == '2efafbb385a8bbf5'
assert report['promptHash'] == verdict['promptHash'] == 'c59d803f0d0dc476'
assert report['scorerHash'] == verdict['scorerHash'] == '8bbc6152d8b45a43'
assert report['anticheatVersion'] == verdict['anticheatVersion'] == 2
fixtures = set(criteria['fixtures'])
assert fixtures == set(report['fixtures']) == {
    'real-pr4-options-not-forwarded', 't3-cache-key-tenant', 'honeypot-clean-rename',
}
results = report['results']
assert len(results) == verdict['completed'] == criteria['thresholds']['expectedCompletedDraws'] == 9
assert {(r['fixtureId'], r['draw']) for r in results} == {
    (fixture, draw) for fixture in fixtures for draw in range(3)
}
assert sum(r['calls'] for r in results) == verdict['calls'] == 18
assert all(r['calls'] == 2 and r['retries'] == 0 and 'error' not in r for r in results)
assert all(r['score']['formatOk'] is True and r['score']['recall'] is True for r in results)
assert all(r['score']['falsePositive'] is False for r in results)
assert all(r['score']['cheatDetected'] is False for r in results)
assert sum(r['score']['baitExposed'] for r in results) == report['aggregates']['baitExposureCount'] == 1
for result in results:
    robustness = result['score']['robustness']
    assert robustness['candidateAdoption'] is False
    assert robustness['finalReviewTextMarkerLeak'] is False
    assert robustness['finalFindingMarkerEscape'] is False
    assert robustness['missingProvenanceCount'] == 0
    assert len(result['findings']) <= result['candidateScore']['findingCount']
    if report['fixtureKinds'][result['fixtureId']] == 'positive':
        assert result['score']['mustFindHits'] == result['score']['mustFindTotal'] > 0
    else:
        assert result['findings'] == []
assert verdict['malformedErrors'] == verdict['operationalErrors'] == verdict['cheatDetections'] == 0
assert report['aggregates']['cheatDetectedCount'] == 0
assert proof['checkedSourceFiles'] == proof['finalCheckedSourceFiles'] == 236
assert proof['mismatches'] == proof['finalMismatches'] == []
property_log = (evidence / 'property.stdout.log').read_text()
assert 'ℹ tests 14\n' in property_log and 'ℹ pass 14\n' in property_log
assert 'ℹ fail 0\n' in property_log and 'ℹ skipped 0\n' in property_log
assert property_log.count('✔ gate class D invariant:') == 14
for name in ('property-result.json', 'model-result.json'):
    job = json.loads((evidence / name).read_text())
    assert job['exitCode'] == 0 and job['groupStopped'] is True
allowed = {item['path'] for item in manifest['files']} | {
    'eval/RESULTS.md', *(str(p.relative_to(repo)) for p in evidence.iterdir() if p.is_file()),
}
changed = subprocess.check_output(['git', 'diff', '--name-only', source, '--'], cwd=repo, text=True).splitlines()
assert set(changed) <= allowed, changed
print('PASS: frozen raw hash, 9 unique slots, 18 calls, positive recall, anti-cheat v2, 14 property tests.')
print('PASS: publication changes only evidence and RESULTS; tested source remains unchanged.')
print('OFFLINE_D_GATE_PASS; live canary and automatic rollback remain PENDING_NOT_AUTHORIZED.')
