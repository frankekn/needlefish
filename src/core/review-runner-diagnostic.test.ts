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
    assert.deepEqual(events.map(event => ({ content: event.content, diagnostic: Reflect.get(event, "diagnostic"), surface: event.surface, outcome: event.outcome, runnerAttempt: event.runnerAttempt })), [{ content: raw, diagnostic: "unrecognized_codex_event_schema", surface: "raw_failure", outcome: "runner_failed", runnerAttempt: 1 }]);
    assert.equal(Object.isFrozen(events[0]), true);
    return error.message;
  };
  assert.equal(await run(false), await run(true));
});
