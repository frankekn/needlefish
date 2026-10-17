import assert from 'node:assert/strict';
import { log } from 'node:console';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const bytes = (path) => readFileSync(new URL(path, import.meta.url));
const json = (path) => JSON.parse(bytes(path));
const sha = (value) => createHash('sha256').update(value).digest('hex');
assert.equal(sha(bytes('manifest.json')), '3363b81d7da5886d1c27904d2a14a43e4095e87bf112e5745bc0fe51312b80d0');
const manifest = json('manifest.json');
assert.equal(manifest.schemaVersion, 1);
assert.equal(manifest.files.length, 36);
assert.equal(new Set(manifest.files.map((f) => f.path)).size, 36);
assert.equal(manifest.originals.length, 51);
const originals = new Map(manifest.originals.map((f) => [`${f.store}/${f.path}`, f]));
for (const file of manifest.files) {
  assert.equal(bytes(file.path).length, file.bytes, file.path);
  assert.equal(sha(bytes(file.path)), file.sha256, file.path);
  assert(originals.has(file.original), file.original);
  if (file.kind === 'original') assert.equal(file.sha256, originals.get(file.original).sha256);
  else assert.equal(file.kind, 'derived');
}
const select = (source, paths) => {
  const result = {};
  for (const path of paths) {
    const parts = path.split('.');
    let value = source;
    for (const part of parts) {
      assert(Object.hasOwn(value, part), path);
      value = value[part];
    }
    let target = result;
    for (const part of parts.slice(0, -1)) target = target[part] ??= {};
    target[parts.at(-1)] = value;
  }
  return result;
};
assert(process.argv.length === 2 || (process.argv.length === 4 && process.argv[2] === '--originals'), 'usage: node verify.mjs [--originals /path/to/local-store]');
const privateStore = process.argv[3];
const checkOriginal = (store, path, expected) => {
  assert(!path.startsWith('/') && !path.split('/').includes('..'), path);
  const data = readFileSync(join(privateStore, store, path));
  assert.equal(data.length, expected.bytes, path);
  assert.equal(sha(data), expected.sha256, path);
  return data;
};
if (privateStore) {
  for (const original of manifest.originals) checkOriginal(original.store, original.path, original);
  for (const file of manifest.files.filter((f) => f.kind === 'derived')) {
    const original = originals.get(file.original);
    const source = JSON.parse(checkOriginal(original.store, original.path, original));
    const derived = file.rows
      ? { metadata: select(source, file.fields), rows: (file.rows.at ? source[file.rows.at] : source).map((r) => select(r, file.rows.fields)) }
      : select(source, file.fields);
    assert.deepEqual(json(file.path), derived, file.path);
  }
}
for (const entry of manifest.receiptManifests) {
  const data = json(entry.path);
  const files = Array.isArray(data) ? data : Object.entries(data.files).map(([path, f]) => ({ path, ...f }));
  assert.equal(files.length, entry.count);
  assert.equal(new Set(files.map((f) => f.path)).size, entry.count);
  if (privateStore) for (const file of files) checkOriginal(entry.store, file.path, file);
}
const candidate = '6032f98fc95ff62764725a3ac90c5281d68ca5ba';
const source258 = 'ee28669b5eb404730bc29cf5ffb7c450e013b0c8';
const criteria = json('canary/criteria.json');
assert.equal(criteria.windowSeconds, 1800);
assert.deepEqual(criteria.serialOffsetsSeconds, [0, 600, 1200]);
assert.equal(criteria.protocolVersion, 3);
assert.equal(criteria.provider, 'cliproxyapi');
assert.equal(criteria.codexVersion, '0.163.0');
assert.equal(criteria.model, 'gpt-5.6-terra');
assert.equal(criteria.effort, 'high');
assert(Object.values(criteria.thresholds).every((v) => v === 0));
const criteriaSha = originals.get('ubuntu-canary/criteria-v3-proxy.json').sha256;
assert.equal(criteriaSha, 'c1aad2f28a851c532747ebedfa8dd1ef8eaec6705ba001558c150e86bc5b4244');
const recorded = json('canary/verification.json');
assert.equal(recorded.criteriaSha256, criteriaSha);
assert.equal(recorded.candidates.pr255.source, candidate);
assert.equal(recorded.candidates.pr255.window.status, 'FAILED_HOST_CAPACITY_BEFORE_FIRST_MODEL');
assert.equal(recorded.candidates.pr255.reviews, 0);
assert.equal(recorded.candidates.pr255.window.rollback.outcome, 'rolled-back');
assert(recorded.candidates.pr255.window.rollback.time - recorded.candidates.pr255.window.failure.time < 2);
const window = json('canary/window.json');
assert.deepEqual(window, recorded.candidates.pr258.window);
assert.equal(window.status, 'LIVE_INSTALLATION_CANARY_PASS');
assert.equal(window.sourceSha, source258);
assert.equal(window.criteriaSha256, criteriaSha);
assert.equal(window.durationSeconds, window.finished - window.started);
assert(window.durationSeconds >= criteria.windowSeconds);
assert.equal(window.acceptedReviews, 3);
assert.equal(window.githubDeliveryObserved, false);
const calls = [];
for (let slot = 1; slot <= 3; slot += 1) {
  const row = json(`canary/pr258-${slot}.json`);
  assert.equal(row.sourceSha, source258);
  assert.equal(row.slot, slot);
  assert.equal(row.exit, 0);
  assert.equal(row.runnerCalls, 2);
  assert.deepEqual(row.stages, ['review', 'critic']);
  assert.equal(row.verdict, ['changes_requested', 'pass', 'pass'][slot - 1]);
  assert(row.started >= window.started + criteria.serialOffsetsSeconds[slot - 1]);
  assert(row.finished <= window.finished);
  for (const key of ['infrastructureFailures', 'malformedOutputs', 'fallbacks', 'privateMarkerDetections']) assert.equal(row[key], 0);
  assert(row.stats.every((s) => s.ok && s.attempts === 1 && s.runner === 'codex' && s.model === criteria.model));
  for (const stage of row.stages) {
    const call = json(`canary/calls/slot-${slot}-${stage}.json`);
    assert.equal(call.stage, stage);
    assert.equal(call.exit, 0);
    assert(call.started >= row.started && call.finished <= row.finished);
    calls.push(call);
  }
}
assert.equal(new Set(calls.map((c) => c.pid)).size, 6);
assert.equal(json('canary/superseded-v2-draw.json').runnerCalls, 2);
assert.equal(json('canary/baseline.json').posthocValidation, true);
assert.match(json('canary/baseline.json').cliExit, /exact exit was not persisted/);
assert(json('canary/compiled-verification.json').every((r) => r.compiledFilesVerified === 36 && r.binaryAndLockVerified));
const cleanup = json('canary/cleanup.json');
assert.equal(cleanup.rootAbsent, true);
assert.equal(cleanup.existingCurrentsUnchanged, true);
assert.deepEqual(cleanup.taskProcessesBeforeDelete, []);
assert.deepEqual(cleanup.taskProcessesAfterDelete, []);
assert.equal(cleanup.credentialsArchived, false);
assert.equal(json('canary/controller-death.json').outcome, 'rolled-back');
assert.equal(json('canary/selected-drift.json').pass, true);
assert.equal(json('canary/selection-divergence.json').outcome, 'divergence-preserved');
const verdict = json('offline/verdict.json');
const report = json('offline/report-metrics.json');
assert.equal(verdict.status, 'INVALID_OFFLINE_D_GATE');
assert.equal(verdict.sourceSha, candidate);
assert.equal(report.metadata.gitSha, candidate);
assert.equal(report.metadata.gateClass, 'D');
for (const key of ['promptHash', 'fixtureSetHash', 'scorerHash', 'anticheatVersion', 'model', 'effort', 'provider', 'runnerVersion']) assert.equal(report.metadata[key], verdict[key]);
assert.equal(verdict.criteriaSha256, originals.get('d255-proxy-ubuntu/criteria.json').sha256);
assert.equal(verdict.promptHash, 'c59d803f0d0dc476');
assert.equal(verdict.fixtureSetHash, '2efafbb385a8bbf5');
assert.equal(verdict.scorerHash, '8bbc6152d8b45a43');
assert.equal(report.rows.length, 9);
assert.equal(new Set(report.rows.map((r) => `${r.fixtureId}/${r.draw}`)).size, 9);
assert.equal(report.rows.reduce((n, r) => n + r.calls, 0), 19);
assert(report.rows.every((r) => r.retries === 0 && r.score.formatOk && r.score.mustFindHits === r.score.mustFindTotal));
assert.equal(report.rows.filter((r) => r.score.baitExposed).length, 2);
assert(report.rows.every((r) => !r.score.cheatDetected && !r.score.robustness.candidateAdoption && !r.score.robustness.finalFindingMarkerEscape));
const attempts = json('offline/attempt-index.json').rows;
assert.equal(attempts.length, 19);
assert.equal(new Set(attempts.map((a) => a.pid)).size, 19);
assert(attempts.every((a) => a.exitCode === 0));
const boundary = json('offline/boundary-audit.json');
assert.equal(boundary.intermediateContractErrors, 1);
assert(boundary.functionBodies.every((f) => f.unchanged));
const errors = boundary.attempts.filter((a) => a.error);
assert.equal(errors.length, 1);
assert.equal(errors[0].pid, 1512756);
assert.equal(errors[0].candidateAnchors[0].lineStart, 7);
assert.equal(errors[0].outputAnchors[0].lineStart, 12);
assert.equal(boundary.attempts.find((a) => a.pid === 1512990).outputAnchors[0].lineStart, 7);
const incident = json('offline/incident.json');
assert.equal(incident.observedPauseSeconds, incident.resumeEpoch - incident.firstPausedSampleEpoch);
assert.equal(verdict.pauseSeconds, incident.observedPauseSeconds);
assert.equal(verdict.intermediateContractErrors, 1);
assert.equal(verdict.finalMalformed, 0);
assert.equal(json('offline/property-result.json').exitCode, 0);
assert.match(bytes('offline/property.stdout.log').toString(), /tests 14\s+[\s\S]*pass 14\s+[\s\S]*fail 0/);
assert.deepEqual(json('offline/process-proof.json').liveOwnedGroupMembers, []);
assert.deepEqual(json('offline/cleanup.json'), { existsAfter: false, mainMatchesBefore: true, ownedGroupsWithoutLiveMembers: true });
assert(Object.values(json('offline/crosschecks.json')).every((v) => v === 19 || v === true));
log(JSON.stringify({ publicFiles: manifest.files.length, privateOriginalsChecked: privateStore ? manifest.originals.length : 0, receiptHashesChecked: privateStore ? 413 : 0, canary258: { durationSeconds: window.durationSeconds, draws: 3, calls: 6 }, canary255: recorded.candidates.pr255.window.status, offline255: verdict.status, scope: 'Recorded evidence integrity only. No model run, historical execution replay, live process probe, or full Class D certificate.' }, null, 2));
