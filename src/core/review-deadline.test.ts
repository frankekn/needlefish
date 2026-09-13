import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { review } from "./review.js";
import { runCodex } from "../shared/codex.js";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures.js";
import type { Bundle } from "../shared/schema.js";

function fixture(t: TestContext, behavior = "valid") {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-deadline-"));
  const repo = initRepo(tmp);
  const calls = path.join(tmp, "calls");
  const bin = path.join(tmp, "codex.cjs");
  const env = ["CODEX_BIN", "NEEDLEFISH_REVIEW_TIMEOUT_MS", "NEEDLEFISH_RETRY_MS", "NEEDLEFISH_NO_RETRY", "NEEDLEFISH_DEEP_CONCURRENCY"];
  const previous = env.map((key) => process.env[key]);
  t.after(() => {
    env.forEach((key, i) => {
      if (previous[i] === undefined) delete process.env[key];
      else process.env[key] = previous[i];
    });
    rmSync(tmp, { recursive: true, force: true });
  });
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const phase = input.includes('review-MAP pass') ? 'map' : input.includes('doing a DEEP review') ? 'deep' : input.includes('adversarial critic') ? 'critic' : 'review';
  const calls = ${JSON.stringify(calls)};
  fs.appendFileSync(calls, phase + '\\n');
  if (${JSON.stringify(behavior)} === 'fail') process.exit(1);
  if (${JSON.stringify(behavior)} === 'hang') { setInterval(() => {}, 1000); return; }
  const count = fs.readFileSync(calls, 'utf8').trim().split('\\n').length;
  const value = phase === 'map'
    ? { summary: 'mapped', hotspots: Array.from({ length: 6 }, (_, i) => ({ name: 'surface-' + i, files: ['src/f' + i + '.ts'], risk: 'high', why: 'changed source', edges: [] })) }
    : { summary: 'reviewed', findings: [], checked: ['source checked'], residual_risks: [] };
  setTimeout(() => fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], ${JSON.stringify(behavior)} === 'repair' && count === 1 ? 'invalid JSON' : JSON.stringify(value)), ${JSON.stringify(behavior)} === 'slow' ? 400 : 0);
});
`);
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_NO_RETRY = "1";
  process.env.NEEDLEFISH_DEEP_CONCURRENCY = "3";
  delete process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS;
  const bundle: Bundle = {
    repoPath: repo, baseSha: "base", headSha: headSha(repo), patch: "short", patchStat: "7 source files changed",
    changedFiles: Array.from({ length: 7 }, (_, i) => ({ path: `src/f${i}.ts`, surface: "source" })),
    agentsMd: "(none)", prMeta: null, deep: true, focus: null,
  };
  return { bundle, calls: () => readFileSync(calls, "utf8").trim().split("\n") };
}

test("shared deadline preserves successful seven-hotspot pipeline output", async (t) => {
  const f = fixture(t);
  const before = await review(f.bundle);
  process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "60000";
  const after = await review(f.bundle);
  const stable = (result: typeof before) => ({ ...result, totalDurationMs: 0, stats: result.stats?.map((s) => ({ ...s, durationMs: 0 })).sort((a, b) => a.label.localeCompare(b.label)) });
  assert.deepEqual(stable(after), stable(before));
  assert.equal(f.calls().length, 18); // map + seven deep (including tail) + critic, twice.
  assert.equal(after.verdict, "pass");
});

test("JSON repair and subsequent critic share the original deadline", async (t) => {
  const f = fixture(t, "repair");
  let now = 0;
  t.mock.method(performance, "now", () => now);
  process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "10000";
  await assert.rejects(review({ ...f.bundle, deep: false }, {}, (event) => {
    if (event.surface === "raw_success") now += 6000;
  }), /review deadline/);
  assert.deepEqual(f.calls(), ["review", "review"]);
});

test("concurrent deep workers cannot start queued hotspots or critic after deadline", async (t) => {
  const f = fixture(t);
  let now = 0;
  t.mock.method(performance, "now", () => now);
  process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "10000";
  await assert.rejects(review(f.bundle, {}, (event) => {
    if (event.passKind === "deep" && event.surface === "raw_success") now = 10001;
  }), /review deadline/);
  const calls = f.calls();
  assert.equal(calls[0], "map");
  assert.ok(calls.length >= 2 && calls.length <= 4, JSON.stringify(calls));
  assert.ok(calls.slice(1).every((phase) => phase === "deep"));
});

test("runner retry backoff cannot escape the shared deadline", async (t) => {
  const f = fixture(t, "fail");
  t.mock.method(performance, "now", () => 0);
  process.env.NEEDLEFISH_NO_RETRY = "0";
  process.env.NEEDLEFISH_RETRY_MS = "1000";
  await assert.rejects(runCodex("fixture", { repoPath: f.bundle.repoPath, targetHeadSha: f.bundle.headSha, reviewDeadlineMs: 500, timeoutMs: 5000 }), /review deadline/);
  assert.equal(f.calls().length, 1);
});

test("live runner timeout is clipped to the remaining review budget", async (t) => {
  const f = fixture(t, "hang");
  const started = performance.now();
  await assert.rejects(runCodex("fixture", { repoPath: f.bundle.repoPath, targetHeadSha: f.bundle.headSha, reviewDeadlineMs: started + 500, timeoutMs: 5000 }), /ETIMEDOUT/);
  assert.ok(performance.now() - started < 2500, "per-call timeout must not override the shorter shared budget");
  assert.equal(f.calls().length, 1);
});

// Seven hotspots require three deep waves: even without preparation/cleanup,
// five serial stages at 400ms cannot fit the shared 1500ms deadline.
test("seven slow hotspots across three workers stop within the pipeline budget", async (t) => {
  const f = fixture(t, "slow");
  process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "1500";
  const started = performance.now();
  await assert.rejects(review(f.bundle, { timeoutMs: 450 }), /deadline|ETIMEDOUT/);
  assert.ok(performance.now() - started < 2500, "shared deadline plus process cleanup grace");
  assert.ok(f.calls().filter((phase) => phase === "deep").length >= 3, "exercise concurrent deep workers");
  assert.ok(!f.calls().includes("critic"), "expired work must not receive a fresh critic allowance");
});
