import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runText, runTextAsync } from "./process";

test("runText reports spawn errors", () => {
  assert.throws(() => runText("__needlefish_missing_command__", []), /ENOENT/);
});

test("runText trims stdout by default", () => {
  const script = "process.stdout.write(' abc \\n \\n');";
  assert.equal(runText(process.execPath, ["-e", script]), "abc");
});

test("runText preserveOutput keeps trailing whitespace including a blank context line", () => {
  const script = "process.stdout.write(' abc \\n \\n');";
  assert.equal(
    runText(process.execPath, ["-e", script], { preserveOutput: true }),
    " abc \n \n"
  );
});

test("runText still trims stderr on command failure", () => {
  const script = "process.stderr.write(' boom \\n'); process.exit(1);";
  assert.throws(
    () => runText(process.execPath, ["-e", script]),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, `${process.execPath} -e ${script} failed: boom`);
      return true;
    }
  );
});

test("runTextAsync spawns nothing on an already-aborted signal", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-run-async-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const marker = path.join(tmp, "ran");
  const script = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'), 300);`;
  const controller = new AbortController();
  controller.abort();
  const started = Date.now();
  await assert.rejects(
    runTextAsync(process.execPath, ["-e", script], { timeoutMs: 10_000, abortSignal: controller.signal }),
    /aborted before start/,
  );
  assert.ok(Date.now() - started < 200, "must settle without waiting on a child");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(existsSync(marker), false, "no child may run after abort");
});

test("runTextAsync kills the child when the signal aborts mid-run", async (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-run-async-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const marker = path.join(tmp, "ran");
  const script = `process.on('SIGTERM', () => {}); setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1'), 600);`;
  const controller = new AbortController();
  const pending = runTextAsync(process.execPath, ["-e", script], { timeoutMs: 10_000, abortSignal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, /failed: SIGKILL/);
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(existsSync(marker), false, "the child must die with the abort");
});

test("runTextAsync SIGKILLs a child that outlives its bound", async () => {
  const started = Date.now();
  await assert.rejects(
    runTextAsync(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { timeoutMs: 200 }),
    /timed out after 200ms/,
  );
  assert.ok(Date.now() - started < 2000);
});
