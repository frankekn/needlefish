import assert from "node:assert/strict";
import test from "node:test";
import { hasResolvedModelIdentity, runnerEnvironmentAttestationError } from "./runner-attestation.js";

const report = {
  runner: "codex" as const, model: null, effort: null,
  provider: "synthetic", route: "synthetic-offline", runnerVersion: "test-1", privateEnvironment: false,
};
const environment = (entries: readonly (readonly [string, string])[]) => JSON.stringify([
  ["NEEDLEFISH_EPHEMERAL_HOME", "1"], ["NEEDLEFISH_EVAL_TRACE", "1"], ...entries,
]);

test("effective model and effort reject unresolved labels at their resolved source", () => {
  for (const sentinel of ["unknown", "private", "unspecified", "unresolved"]) {
    for (const value of [sentinel, ` ${sentinel.toUpperCase()}\t`]) {
      for (const identity of [
        { model: value, effort: "high", runnerEnvironment: environment([]) },
        { model: "synthetic", effort: value, runnerEnvironment: environment([]) },
        { runnerEnvironment: environment([["NEEDLEFISH_MODEL", value], ["CODEX_REASONING_EFFORT", "high"]]) },
        { runnerEnvironment: environment([["CODEX_MODEL", value], ["CODEX_REASONING_EFFORT", "high"]]) },
        { runnerEnvironment: environment([["CODEX_MODEL", "synthetic"], ["CODEX_REASONING_EFFORT", value]]) },
      ]) {
        const input = { ...report, ...identity };
        assert.equal(hasResolvedModelIdentity(input), false, JSON.stringify(input));
        assert.equal(runnerEnvironmentAttestationError(input), "public lanes require a resolved model and effort identity");
      }
    }
  }
});

test("effective identity preserves explicit, environment and Pi default precedence", () => {
  const identities = [
    { runnerEnvironment: environment([["NEEDLEFISH_MODEL", "synthetic"], ["CODEX_REASONING_EFFORT", "high"]]) },
    { runnerEnvironment: environment([["CODEX_MODEL", "synthetic"], ["CODEX_REASONING_EFFORT", "high"]]) },
    { model: "synthetic", effort: "high", runnerEnvironment: environment([["NEEDLEFISH_MODEL", "unknown"], ["CODEX_REASONING_EFFORT", "private"]]) },
    { runnerEnvironment: environment([["NEEDLEFISH_MODEL", "synthetic"], ["CODEX_MODEL", "unknown"], ["CODEX_REASONING_EFFORT", "high"]]) },
    { runner: "pi" as const, runnerEnvironment: environment([]) },
  ];
  for (const identity of identities) {
    const input = { ...report, ...identity };
    assert.equal(hasResolvedModelIdentity(input), true);
    assert.equal(runnerEnvironmentAttestationError(input), null);
  }
  assert.equal(hasResolvedModelIdentity({ ...report, runnerEnvironment: environment([]) }), false);
  assert.equal(hasResolvedModelIdentity({ ...report, runnerEnvironment: environment([["NEEDLEFISH_MODEL", "unknown"], ["CODEX_MODEL", "synthetic"], ["CODEX_REASONING_EFFORT", "high"]]) }), false);
});

test("Grok identity requires a captured effective model", () => {
  const input = { ...report, runner: "grok" as const, effort: "high", runnerEnvironment: environment([]) };
  assert.equal(hasResolvedModelIdentity(input), false);
  assert.equal(runnerEnvironmentAttestationError(input), "public lanes require a resolved model and effort identity");
  for (const source of ["NEEDLEFISH_MODEL", "GROK_MODEL"]) {
    assert.equal(hasResolvedModelIdentity({ ...input, runnerEnvironment: environment([[source, "unresolved"]]) }), false);
  }
  assert.equal(hasResolvedModelIdentity({ ...input, model: "explicit", runnerEnvironment: environment([["GROK_MODEL", "unknown"]]) }), true);
  assert.equal(hasResolvedModelIdentity({ ...input, runnerEnvironment: environment([["NEEDLEFISH_MODEL", "explicit"], ["GROK_MODEL", "unknown"]]) }), true);
  assert.equal(hasResolvedModelIdentity({ ...input, runner: "codex" }), false);
  assert.equal(hasResolvedModelIdentity({ ...input, runnerEnvironment: environment([["GROK_MODEL", "grok-build"]]) }), true);
});
