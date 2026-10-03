import assert from "node:assert/strict";
import test from "node:test";
import { findRunnerFailure, RunnerFailure } from "./runner-failure.js";

test("runner failure keeps explicit adapter metadata", () => {
  const failure = new RunnerFailure("auth_required", "Sign in with the agent CLI.");
  assert.ok(failure instanceof Error);
  assert.equal(failure.kind, "auth_required");
  assert.equal(failure.retryable, false);
  assert.equal(findRunnerFailure(failure), failure);
});

test("unknown adapter failures can preserve bounded legacy retry", () => {
  const failure = new RunnerFailure("unknown", "Agent failed.", true);
  assert.equal(findRunnerFailure(failure)?.retryable, true);
});

test("runner failure survives operational error wrappers without copying raw data", () => {
  const failure = new RunnerFailure("permission_required", "Review cancelled.");
  const wrapped = new Error("Runner failed.", { cause: new Error("Process failed.", { cause: failure }) });
  assert.equal(findRunnerFailure(wrapped), failure);
});

test("runner failure does not classify arbitrary objects or error messages", () => {
  for (const value of [
    null, undefined, "quota exceeded",
    { kind: "auth_required", retryable: false },
    new Error("quota exceeded; permission_required; auth_required"),
    new Error("wrapped", { cause: { kind: "cancelled", retryable: false } }),
  ]) {
    assert.equal(findRunnerFailure(value), undefined);
  }
});

test("runner failure handles self-referential and cyclic causes", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  Object.defineProperty(a, "cause", { value: b });
  assert.equal(findRunnerFailure(a), undefined);
});

test("runner failure never invokes a cause getter", () => {
  const error = new Error("getter");
  Object.defineProperty(error, "cause", { get() { throw new Error("must not execute"); } });
  assert.equal(findRunnerFailure(error), undefined);
});

test("runner failure ignores inherited causes", () => {
  const error = new Error("inherited");
  Object.setPrototypeOf(error, Object.create(Error.prototype, {
    cause: { value: new RunnerFailure("cancelled", "cancelled") },
  }));
  assert.equal(findRunnerFailure(error), undefined);
});

test("runner failure bounds diagnostic traversal", () => {
  let error: Error = new RunnerFailure("cancelled", "cancelled");
  for (let i = 0; i < 16; i += 1) error = new Error("wrapper", { cause: error });
  assert.equal(findRunnerFailure(error), undefined);
});
