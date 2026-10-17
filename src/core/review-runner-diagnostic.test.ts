import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { headSha, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { findRunnerFailure } from "../shared/runner-failure.js";
import { review } from "./review.js";
import type { ReviewTraceEvent } from "./review-trace.js";

test("unknown runner schema diagnostic stays separate from every raw transcript", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-schema-trace-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex.cjs");
  const previous = { ...process.env };
  t.after(() => { process.env = previous; rmSync(tmp, { recursive: true, force: true }); });
  const stdout = '{"type":"future.event","message":"CANARY-FUTURE insufficient credits"}\n';
  const stderr = "stderr CANARY-STDERR";
  const output = "output CANARY-FILE";
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0);
fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], ${JSON.stringify(output)});
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(1);
`);
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  process.env.NEEDLEFISH_NO_RETRY = "1";
  process.env.NEEDLEFISH_EVAL_TRACE = "1";
  const bundle = { repoPath: repo, baseSha: "base", headSha: headSha(repo), patch: "short", patchStat: " src/app.ts | 1 +", changedFiles: [{ path: "src/app.ts", surface: "source" as const }], agentsMd: "(none)", prMeta: null, deep: false, focus: null };
  const run = async (observerThrows: boolean) => {
    const events: ReviewTraceEvent[] = [];
    const error: unknown = await review(bundle, {}, event => {
      events.push(event);
      if (observerThrows) throw new Error("private observer failed");
    }).then(() => null, (error: unknown) => error);
    assert.ok(error instanceof Error);
    assert.notEqual(findRunnerFailure(error)?.kind, "quota_exhausted");
    assert.match(error.message, /runner exited 1/);
    assert.doesNotMatch(error.message, /CANARY|future.event|unrecognized/);
    assert.doesNotMatch(JSON.stringify(error), /unrecognized_codex_event_schema/);
    const raw = `${output}\n${stdout}\n${stderr}`;
    assert.deepEqual(Reflect.get(error, "rawOutputs"), [raw]);
    assert.equal(Reflect.get(error, "rawOutput"), raw);
    assert.deepEqual(events.filter(event => event.surface === "raw_failure").map(event => ({ content: event.content, diagnostic: Reflect.get(event, "diagnostic"), surface: event.surface, outcome: event.outcome, runnerAttempt: event.runnerAttempt })), [{ content: raw, diagnostic: "unrecognized_codex_event_schema", surface: "raw_failure", outcome: "runner_failed", runnerAttempt: 1 }]);
    assert.deepEqual(events.filter(event => event.surface === "native_tool_receipts").map(event => ({ adapter: event.toolTrace.adapter, toolRead: event.toolTrace.toolRead, invocation: event.toolTrace.invocation, runnerAttempt: event.runnerAttempt })), [{ adapter: "codex", toolRead: "unknown", invocation: "exit_nonzero", runnerAttempt: 1 }]);
    assert.equal(Object.isFrozen(events[0]), true);
    return error.message;
  };
  assert.equal(await run(false), await run(true));
});

test("private diagnostic observer failure preserves the retried review verdict", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-schema-retry-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "codex.cjs");
  const calls = path.join(tmp, "calls");
  const previous = { ...process.env };
  t.after(() => { process.env = previous; rmSync(tmp, { recursive: true, force: true }); });
  writeFileSync(bin, `#!/usr/bin/env node
const fs = require("node:fs");
fs.readFileSync(0);
const calls = ${JSON.stringify(calls)};
const count = Number(fs.readFileSync(calls, "utf8")) + 1;
fs.writeFileSync(calls, String(count));
if (count === 1) {
  process.stdout.write('{"type":"future.event","message":"insufficient credits"}\\n');
  process.exit(1);
}
fs.writeFileSync(process.argv[process.argv.indexOf("--output-last-message") + 1], JSON.stringify({ summary: "clean", findings: [], checked: ["source reviewed"], residual_risks: [] }));
`);
  chmodSync(bin, 0o755);
  process.env.CODEX_BIN = bin;
  delete process.env.NEEDLEFISH_NO_RETRY;
  process.env.CODEX_RETRY_MS = "1";
  const bundle = { repoPath: repo, baseSha: "base", headSha: headSha(repo), patch: "short", patchStat: " src/app.ts | 1 +", changedFiles: [{ path: "src/app.ts", surface: "source" as const }], agentsMd: "(none)", prMeta: null, deep: false, focus: null };
  const run = async (observerThrows: boolean) => {
    writeFileSync(calls, "0");
    const events: ReviewTraceEvent[] = [];
    const result = await review(bundle, {}, event => {
      events.push(event);
      if (observerThrows && "diagnostic" in event) throw new Error("private diagnostic observer failed");
    });
    assert.equal(result.verdict, "pass");
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.stats?.map(stat => ({ attempts: stat.attempts, ok: stat.ok })), [{ attempts: 2, ok: true }, { attempts: 1, ok: true }]);
    assert.doesNotMatch(JSON.stringify(result), /unrecognized_codex_event_schema/);
    assert.deepEqual(events.filter(event => event.surface === "raw_failure").map(event => ({ content: event.content, diagnostic: Reflect.get(event, "diagnostic") })), [{ content: '{"type":"future.event","message":"insufficient credits"}\n', diagnostic: "unrecognized_codex_event_schema" }]);
    return result.verdict;
  };
  assert.equal(await run(false), await run(true));
});
