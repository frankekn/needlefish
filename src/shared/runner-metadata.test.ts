import assert from "node:assert/strict";
import test from "node:test";
import { RUNNER_DEFINITIONS as RUNNER_CATALOG } from "./runner-definition.js";
import { RUNNER_DEFINITIONS, RUNNERS } from "./runner.js";

const EXPECTED_METADATA = {
  codex: {
    modelEnv: "CODEX_MODEL",
    envAllowlist: ["CODEX_BIN", "CODEX_MODEL", "CODEX_PROXY_API_KEY", "CODEX_REASONING_EFFORT", "CODEX_RETRY_MS", "CODEX_TIMEOUT_MS"],
    authFiles: [".codex/auth.json", ".codex/config.toml"],
    envConfigFiles: [],
  },
  claude: {
    modelEnv: "CLAUDE_MODEL",
    envAllowlist: ["CLAUDE_BIN", "CLAUDE_MODEL", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
    authFiles: [],
    envConfigFiles: [],
  },
  opencode: {
    modelEnv: "OPENCODE_MODEL",
    envAllowlist: ["OPENCODE_BIN", "OPENCODE_MODEL", "OPENAI_API_KEY"],
    authFiles: [".config/opencode/opencode.json", ".local/share/opencode/auth.json"],
    envConfigFiles: [".config/opencode/opencode.json"],
  },
  openai: {
    modelEnv: "OPENAI_MODEL",
    envAllowlist: [],
    authFiles: [],
    envConfigFiles: [],
  },
  grok: {
    modelEnv: "GROK_MODEL",
    envAllowlist: ["GROK_BIN", "GROK_MODEL"],
    authFiles: [".grok/auth.json", ".grok/config.toml"],
    envConfigFiles: [".grok/config.toml"],
  },
  pi: {
    modelEnv: "PI_MODEL",
    envAllowlist: ["PI_BIN", "PI_MODEL", "PI_PROVIDER", "PI_AUTH_MODE"],
    authFiles: [".pi/agent/auth.json", ".pi/agent/models.json"],
    envConfigFiles: [".pi/agent/models.json"],
  },
  acp: {
    modelEnv: undefined,
    envAllowlist: ["NEEDLEFISH_ACP_BIN"],
    authFiles: [],
    envConfigFiles: [],
  },
} as const;

test("runner metadata index contains exactly the canonical catalog entries", () => {
  assert.deepEqual(Object.keys(RUNNER_DEFINITIONS), RUNNERS);
  assert.deepEqual(Object.keys(EXPECTED_METADATA), RUNNERS);
  for (const definition of RUNNER_CATALOG) {
    assert.equal(RUNNER_DEFINITIONS[definition.name], definition);
  }
});

for (const name of RUNNERS) {
  test(`${name} retains its model, environment and HOME file metadata`, () => {
    const { modelEnv, envAllowlist, authFiles, envConfigFiles } = RUNNER_DEFINITIONS[name];
    assert.deepEqual({ modelEnv, envAllowlist, authFiles, envConfigFiles }, EXPECTED_METADATA[name]);
  });
}
