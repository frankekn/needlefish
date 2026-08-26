import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("deploy does not install or invoke optional model-runner setup", async () => {
  const script = await readFile("scripts/deploy-ubuntu.sh", "utf8");

  assert.doesNotMatch(script, /setup-runner|@openai\/codex|@anthropic-ai\/claude-code|opencode-ai|@mariozechner\/pi/);
});

test("deploy uses Corepack without writing system pnpm shims", async () => {
  const script = await readFile("scripts/deploy-ubuntu.sh", "utf8");

  assert.doesNotMatch(script, /^\s*corepack enable$/m);
  assert.match(script, /corepack pnpm install --frozen-lockfile/);
});

test("hosted action does not require runner permission opt-ins", async () => {
  const action = await readFile("action.yml", "utf8");

  assert.doesNotMatch(
    action,
    /NEEDLEFISH_ALLOW_(?:OPENCODE_RUNNER|PI_RUNNER|GROK_UNSANDBOXED)/,
  );
  assert.doesNotMatch(action, /apparmor_restrict_unprivileged_userns/);
});
