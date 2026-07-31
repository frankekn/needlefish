import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deploy does not install an optional model runner", async () => {
  const script = await readFile("scripts/deploy-ubuntu.sh", "utf8");

  assert.doesNotMatch(script, /npm install -g @mariozechner\/pi/);
});

test("hosted action does not require runner permission opt-ins", async () => {
  const action = await readFile("action.yml", "utf8");

  assert.doesNotMatch(
    action,
    /NEEDLEFISH_ALLOW_(?:OPENCODE_RUNNER|PI_RUNNER|GROK_UNSANDBOXED)/,
  );
  assert.doesNotMatch(action, /apparmor_restrict_unprivileged_userns/);
});
