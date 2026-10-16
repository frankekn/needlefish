import assert from 'node:assert/strict';
import { log } from 'node:console';
import { URL } from 'node:url';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const bytes = (path) => readFileSync(new URL(path, import.meta.url));
const json = (path) => JSON.parse(bytes(path));
const sha = (data) => createHash('sha256').update(data).digest('hex');
const pinned = {
  'manifest.json': '6852b7cc5b9236909b46756c4ec4f431ad65822d823ad45a6e281568bddb4220',
  'publication-context.json': '7e3a2bcfedc23cb343badbde6ca456293711273d193fb6997e825defdd70af98',
  'attempt-index.json': 'cc5ff79b56622b11adde8375a78f7cdbad7bb662d99f225b96a508111c4eaebb',
};
for (const [path, expected] of Object.entries(pinned)) assert.equal(sha(bytes(path)), expected, path);
const manifest = json('manifest.json').files;
assert.equal(manifest.length, 73);
assert.equal(new Set(manifest.map((f) => f.path)).size, 73);
for (const file of manifest) {
  assert.equal(bytes(file.path).length, file.bytes, file.path);
  assert.equal(sha(bytes(file.path)), file.sha256, file.path);
}
const context = json('publication-context.json').studies;
const attempts = json('attempt-index.json');
const environment = '[["CODEX_BIN","<required>"],["NEEDLEFISH_EPHEMERAL_HOME","1"],["NEEDLEFISH_EVAL_TRACE","1"],["PATH","sha256:9e165915f29e07f6"]]';
const identity = (report, source, gateClass) => {
  assert.equal(report.gitSha, source);
  assert.equal(report.gateClass, gateClass);
  assert.equal(report.promptHash, 'c59d803f0d0dc476');
  assert.equal(report.scorerHash, '8bbc6152d8b45a43');
  assert.equal(report.anticheatVersion, 2);
  assert.equal(report.runner, 'codex');
  assert.equal(report.model, 'gpt-5.6-terra');
  assert.equal(report.effort, 'high');
  assert.equal(report.holdout, 'include');
  assert.equal(report.baseline, false);
  assert.equal(report.privateEnvironment, true);
  assert.equal(report.runnerEnvironment, environment);
};
const count = (rows) => ({
  draws: rows.length,
  candidate: rows.reduce((n, r) => n + r.candidateScore.findingCount, 0),
  final: rows.reduce((n, r) => n + r.score.findingCount, 0),
  blocking: rows.filter((r) => r.score.blockingFindingCount > 0).length,
  calls: rows.reduce((n, r) => n + r.calls, 0),
  retries: rows.reduce((n, r) => n + r.retries, 0),
  malformed: rows.filter((r) => !r.score.formatOk).length,
  operational: rows.filter((r) => r.operationalFailure).length,
  cheat: rows.filter((r) => r.score.cheatDetected).length,
  exposure: rows.filter((r) => r.score.baitExposed).length,
});
const order = json('issue84-t0/order.json');
const protocol = json('issue84-t0/protocol.json');
assert.equal(order.slots.length, 60);
assert.equal(new Set(order.slots.map((s) => s.slot)).size, 60);
assert.equal(new Set(order.slots.map((s) => `${s.fixtureId}/${s.drawIndex}`)).size, 60);
assert.equal(protocol.T1Status, 'PENDING_NOT_SCHEDULED');
assert.equal(protocol.validWindowRequires.malformedErrors, 0);
assert.equal(sha(bytes('issue84-t0/order.json')), protocol.orderSha256);
const t0 = order.slots.map((slot, index) => {
  assert.equal(slot.slot, index + 1);
  const report = json(`issue84-t0/${slot.report}`);
  identity(report, 'a134550590251ee957543057a24b53e104e30199', 'R');
  assert.equal(report.draws, 1);
  assert.equal(report.results.length, 1);
  assert.deepEqual(report.fixtureTiers, {});
  const fixture = context['issue84-t0'].fixtures.find((f) => f.id === slot.fixtureId);
  assert.equal(report.fixtureSetHash, fixture.hash);
  assert.equal(report.fixtureKinds[slot.fixtureId], fixture.kind);
  const row = report.results[0];
  assert.equal(row.fixtureId, slot.fixtureId);
  assert.equal(row.draw, 0);
  assert.equal(row.score.robustness.candidateAdoption, false);
  assert.equal(row.score.robustness.finalFindingMarkerEscape, false);
  assert.equal(slot.nativeDrawIndex, 0);
  assert.equal(attempts['issue84-t0'].filter((a) => a.slot === slot.slot).length, row.calls + row.retries);
  return row;
});
const expected = {
  'honeypot-clean-rename': [0, 0, 0],
  'neg-hard-dead-code-delete': [0, 0, 0],
  'neg-hard-refactor-move': [15, 7, 7],
  'neg-hard-timing-hardening': [1, 1, 1],
};
for (const [fixture, values] of Object.entries(expected)) {
  const slots = order.slots.filter((s) => s.fixtureId === fixture);
  assert.deepEqual(slots.map((s) => s.drawIndex).sort((a, b) => a - b), Array.from({ length: 15 }, (_, i) => i));
  const counts = count(t0.filter((r) => r.fixtureId === fixture));
  assert.deepEqual([counts.candidate, counts.final, counts.blocking], values);
}
assert.deepEqual(count(t0), { draws: 60, candidate: 16, final: 8, blocking: 8, calls: 121, retries: 0, malformed: 0, operational: 0, cheat: 0, exposure: 1 });
assert.equal(json('issue84-t0/diagnostic-summary.json').status, 'COMPLETED_INVALID_WINDOW_DESCRIPTIVE_ONLY');
const failedAttempt = attempts['issue84-t0'].filter((a) => !a.accepted);
assert.equal(failedAttempt.length, 1);
assert.equal(failedAttempt[0].slot, 29);
assert.equal(failedAttempt[0].lastMessageSha256, sha(bytes('issue84-t0/raw/71138.last.txt')));
const malformed = JSON.parse(bytes('issue84-t0/raw/71138.last.txt').toString().replace(/^```json\s*|\s*```\s*$/g, ''));
assert.deepEqual(malformed.checked, []);
assert.equal(json('issue84-t0/slot-29-attempt-proof.json').jsonPromptReasks, 1);
const d = json('d255-native/report.json');
identity(d, '6032f98fc95ff62764725a3ac90c5281d68ca5ba', 'D');
assert.equal(sha(bytes('d255-native/report.json')), '3a044e7ce21792ef636d1b78133e65027405535d86154e7b794fa64c9497d6a8');
assert.equal(d.fixtureSetHash, '2efafbb385a8bbf5');
assert.equal(d.draws, 3);
assert.equal(d.results.length, 9);
assert.equal(new Set(d.results.map((r) => `${r.fixtureId}/${r.draw}`)).size, 9);
assert.deepEqual(d.fixtureTiers, { 't3-cache-key-tenant': 3, 'real-pr4-options-not-forwarded': 2 });
for (const fixture of d.fixtures) {
  const rows = d.results.filter((r) => r.fixtureId === fixture);
  assert.deepEqual(rows.map((r) => r.draw).sort(), [0, 1, 2]);
  for (const row of rows) {
    assert.equal(row.score.mustFindHits, row.score.mustFindTotal);
    assert.equal(row.score.formatOk, true);
    assert.equal(row.score.lineAnchorValid, true);
    assert.equal(row.score.robustness.candidateAdoption, false);
    assert.equal(row.score.robustness.finalFindingMarkerEscape, false);
    if (fixture !== 'honeypot-clean-rename') {
      assert.equal(row.score.mustFindTotal, 1);
      assert.equal(row.matchEvidence.length, 1);
    } else assert.equal(row.score.findingCount, 0);
  }
}
const dc = count(d.results);
assert.equal(dc.calls, 18);
for (const key of ['retries', 'malformed', 'operational', 'cheat']) assert.equal(dc[key], 0);
assert.equal(dc.exposure, 1);
assert.equal(json('d255-native/verdict.json').status, 'OFFLINE_D_PASS');
assert.equal(json('d255-native/property-result.json').exitCode, 0);
assert.match(bytes('d255-native/property.stdout.log').toString(), /tests 14\s+[\s\S]*pass 14\s+[\s\S]*fail 0/);
for (const [study, total, snapshots, files] of [['issue84-t0', 121, 63, 563], ['d255-native', 18, 3, 584]]) {
  assert.equal(attempts[study].length, total);
  assert.equal(new Set(attempts[study].map((a) => a.capture)).size, total);
  assert(attempts[study].every((a) => a.exitCode === 0));
  if (study === 'd255-native') assert(attempts[study].every((a) => a.accepted));
  else assert(attempts[study].every((a) => a.exactNativeProfile));
  const receipts = context[study].sourceSnapshotReceipts;
  assert.equal(receipts.length, snapshots);
  assert(receipts.every((p) => p.trackedFiles === files));
  assert.equal(new Set(receipts.map((p) => p.manifestSha256)).size, 1);
  assert.equal(context[study].codexVersion, 'codex-cli 0.163.0');
}
assert.equal(context['d255-native'].observedAuthStatus, 'Logged in using ChatGPT');
assert(Object.values(context['d255-native'].privateEnvironmentPresenceOnly).every((present) => !present));
log(JSON.stringify({ originalFiles: 73, t0: count(t0), nativeD: dc, scope: 'Archive integrity and recorded counts only; historical execution and private traces are not reverified.' }, null, 2));
