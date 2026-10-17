import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import publicRuntime from "../../runtime-publication.json";
import { RUNNER_DEFINITIONS } from "./runner-definition";
import { resolveRunnerConfig } from "./codex";

test("public version map matches package bytes, actual detection priority and effective Codex default", (t) => {
  const keys = ["NEEDLEFISH_MODEL", "CODEX_MODEL", "CODEX_REASONING_EFFORT", "CODEX_PROXY_BASE_URL", "CODEX_PROXY_API_KEY", "NEEDLEFISH_CODEX_PROXY_REQUIRED"];
  const previous = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  assert.equal(publicRuntime.packageVersion, JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
  assert.deepEqual(RUNNER_DEFINITIONS.filter((entry) => "autoDetect" in entry).map((entry) => entry.name), publicRuntime.packageDefault.runnerPriority);
  assert.equal(resolveRunnerConfig({ runner: "codex" }).effectiveEffort, publicRuntime.packageDefault.codexEffort);
});
