import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { captureEnv, isMissingProcess, killProcessIfRunning, restoreEnv } from "./runner-test-fixtures";

// Cleanup is intentionally independent of the helpers under test.
function envKey(t: TestContext): string {
  const key = `NEEDLEFISH_TEST_ENV_${randomUUID().replaceAll("-", "")}`;
  t.after(() => { delete process.env[key]; });
  return key;
}

test("captureEnv snapshots only requested keys without changing the environment", (t) => {
  const set = envKey(t);
  const empty = envKey(t);
  const absent = envKey(t);
  process.env[set] = "original";
  process.env[empty] = "";
  const snapshot = captureEnv([set, empty, absent]);
  assert.deepEqual([...snapshot], [[set, "original"], [empty, ""], [absent, undefined]]);
  assert.equal(process.env[set], "original");
  assert.equal(process.env[empty], "");
  assert.equal(Object.hasOwn(process.env, absent), false);
  process.env[set] = "changed";
  assert.equal(snapshot.get(set), "original");
});

for (const initial of [undefined, "", "original"] as const) {
  test(`restoreEnv preserves ${initial === undefined ? "an absent key" : JSON.stringify(initial)}`, (t) => {
    const key = envKey(t);
    if (initial !== undefined) process.env[key] = initial;
    const snapshot = captureEnv([key]);
    process.env[key] = "changed";
    restoreEnv(snapshot);
    assert.equal(process.env[key], initial);
    assert.equal(Object.hasOwn(process.env, key), initial !== undefined);
    restoreEnv(snapshot);
    assert.equal(process.env[key], initial);
  });
}

test("restoreEnv does not restore or delete unrelated keys", (t) => {
  const captured = envKey(t);
  const other = envKey(t);
  const snapshot = captureEnv([captured]);
  process.env[captured] = "temporary";
  process.env[other] = "keep";
  restoreEnv(snapshot);
  assert.equal(Object.hasOwn(process.env, captured), false);
  assert.equal(process.env[other], "keep");
  assert.deepEqual([...snapshot], [[captured, undefined]]);
});

test("environment snapshots support explicit nested restoration", (t) => {
  const key = envKey(t);
  const outer = captureEnv([key]);
  process.env[key] = "outer";
  const inner = captureEnv([key]);
  process.env[key] = "inner";
  restoreEnv(inner);
  assert.equal(process.env[key], "outer");
  restoreEnv(outer);
  assert.equal(Object.hasOwn(process.env, key), false);
});

test("explicit finally restoration still runs when test work throws", (t) => {
  const key = envKey(t);
  process.env[key] = "original";
  const snapshot = captureEnv([key]);
  const failure = new Error("work failed");
  assert.throws(() => {
    try {
      process.env[key] = "temporary";
      throw failure;
    } finally {
      restoreEnv(snapshot);
    }
  }, (error: unknown) => error === failure);
  assert.equal(process.env[key], "original");
});

test("isMissingProcess accepts only an Error with ESRCH", () => {
  assert.equal(isMissingProcess(Object.assign(new Error("gone"), { code: "ESRCH" })), true);
  for (const error of [null, undefined, "ESRCH", { code: "ESRCH" }, new Error("ESRCH"), Object.assign(new Error("denied"), { code: "EPERM" })]) {
    assert.equal(isMissingProcess(error), false);
  }
});

test("killProcessIfRunning forwards PID or process-group ID with SIGKILL", (t) => {
  // Never signal a real process in helper unit tests.
  const kill = t.mock.method(process, "kill", () => true);
  killProcessIfRunning(12345);
  killProcessIfRunning(-12345);
  assert.deepEqual(kill.mock.calls.map((call) => call.arguments), [[12345, "SIGKILL"], [-12345, "SIGKILL"]]);
});

test("killProcessIfRunning ignores an already missing process", (t) => {
  t.mock.method(process, "kill", () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
  assert.doesNotThrow(() => killProcessIfRunning(-12345));
});

for (const error of [Object.assign(new Error("denied"), { code: "EPERM" }), { code: "ESRCH" }]) {
  test(`killProcessIfRunning rethrows ${error instanceof Error ? "permission errors" : "non-Error values"}`, (t) => {
    t.mock.method(process, "kill", () => { throw error; });
    assert.throws(() => killProcessIfRunning(-12345), (caught: unknown) => caught === error);
  });
}
