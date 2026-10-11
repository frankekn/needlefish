import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { isRunnerName, parseRunnerName, RUNNERS } from "./runner.js";
import { resolveRunner } from "./runner-detection.js";

const EXPECTED_RUNNERS = ["codex", "claude", "opencode", "openai", "grok", "pi", "acp"] as const;
const EXPECTED_INSTALL_MESSAGE = [
  "No supported model runner found on PATH.",
  "Install one:",
  "  codex: npm install -g @openai/codex",
  "  claude: npm install -g @anthropic-ai/claude-code",
  "  opencode: npm install -g @opencode/cli",
].join("\n");
const ENV_KEYS = ["PATH", "NEEDLEFISH_RUNNER", "CODEX_BIN", "CLAUDE_BIN", "OPENCODE_BIN"] as const;

function isolatedDiscovery(t: TestContext): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "needlefish-runner-definition-"));
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  t.after(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PATH = dir;
  return dir;
}

function executable(dir: string, name: string): string {
  const file = path.join(dir, name);
  // Discovery must only check accessibility, never run an agent to probe it.
  writeFileSync(file, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  return file;
}

test("runner identities and validation preserve the exact public name set and order", () => {
  assert.deepEqual(RUNNERS, EXPECTED_RUNNERS);
  assert.equal(new Set(RUNNERS).size, RUNNERS.length);
  for (const name of EXPECTED_RUNNERS) {
    assert.equal(isRunnerName(name), true);
    assert.equal(parseRunnerName(name, "--runner"), name);
  }
  for (const value of ["", "Codex", "claude-code", " codex", "codex ", "toString", "constructor", "__proto__"]) {
    assert.equal(isRunnerName(value), false);
    assert.throws(() => parseRunnerName(value, "--runner"), {
      message: `--runner must be one of: ${EXPECTED_RUNNERS.join(", ")}`,
    });
  }
});

for (const runner of EXPECTED_RUNNERS) {
  test(`explicit ${runner} selection wins over environment and needs no executable`, (t) => {
    isolatedDiscovery(t);
    process.env.NEEDLEFISH_RUNNER = "not-a-runner";
    assert.equal(resolveRunner({ runner }), runner);
  });
}

for (const runner of EXPECTED_RUNNERS) {
  test(`environment-selected ${runner} needs no auto-detection executable`, (t) => {
    const dir = isolatedDiscovery(t);
    executable(dir, "codex");
    process.env.NEEDLEFISH_RUNNER = runner;
    assert.equal(resolveRunner({}), runner);
  });
}

test("invalid environment selection fails instead of silently auto-detecting", (t) => {
  const dir = isolatedDiscovery(t);
  executable(dir, "codex");
  process.env.NEEDLEFISH_RUNNER = "unknown";
  assert.throws(() => resolveRunner({}), {
    message: `NEEDLEFISH_RUNNER must be one of: ${EXPECTED_RUNNERS.join(", ")}`,
  });
});

test("auto-detection preserves codex then claude then opencode priority", (t) => {
  const dir = isolatedDiscovery(t);
  for (const name of ["opencode", "claude", "codex"]) executable(dir, name);
  for (const expected of ["codex", "claude", "opencode"]) {
    assert.equal(resolveRunner({}), expected);
    rmSync(path.join(dir, expected));
  }
  assert.throws(() => resolveRunner({}), { message: EXPECTED_INSTALL_MESSAGE });
});

for (const [name, env] of [
  ["codex", "CODEX_BIN"],
  ["claude", "CLAUDE_BIN"],
  ["opencode", "OPENCODE_BIN"],
] as const) {
  test(`${name} discovery honors absolute and PATH executable overrides`, (t) => {
    const dir = isolatedDiscovery(t);
    const file = executable(dir, "custom-agent");
    process.env[env] = file;
    assert.equal(resolveRunner({}), name);
    process.env[env] = "custom-agent";
    assert.equal(resolveRunner({}), name);
    process.env[env] = path.relative(process.cwd(), file);
    assert.equal(resolveRunner({}), name);
  });

  test(`${name} with a missing override does not fall back to its ordinary binary`, (t) => {
    const dir = isolatedDiscovery(t);
    executable(dir, name);
    process.env[env] = path.join(dir, "missing");
    assert.throws(() => resolveRunner({}), { message: EXPECTED_INSTALL_MESSAGE });
  });
}

test("an unavailable higher-priority override still permits the next eligible runner", (t) => {
  const dir = isolatedDiscovery(t);
  executable(dir, "codex");
  executable(dir, "claude");
  process.env.CODEX_BIN = path.join(dir, "missing");
  assert.equal(resolveRunner({}), "claude");
});

test("explicit-only runners are not auto-detected even when their binaries exist", (t) => {
  const dir = isolatedDiscovery(t);
  for (const name of ["openai", "grok", "pi", "acp"]) executable(dir, name);
  assert.throws(() => resolveRunner({}), { message: EXPECTED_INSTALL_MESSAGE });
});

test("empty selections and overrides preserve normal PATH discovery", (t) => {
  const dir = isolatedDiscovery(t);
  executable(dir, "codex");
  process.env.NEEDLEFISH_RUNNER = "";
  process.env.CODEX_BIN = "";
  assert.equal(resolveRunner({}), "codex");
});

test("missing and empty PATH retain the original actionable installation message", (t) => {
  isolatedDiscovery(t);
  delete process.env.PATH;
  assert.throws(() => resolveRunner({}), { message: EXPECTED_INSTALL_MESSAGE });
  process.env.PATH = "";
  assert.throws(() => resolveRunner({}), { message: EXPECTED_INSTALL_MESSAGE });
});

test("discovery does not execute the detected binary", (t) => {
  const dir = isolatedDiscovery(t);
  const marker = path.join(dir, "executed");
  writeFileSync(path.join(dir, "codex"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  assert.equal(resolveRunner({}), "codex");
  assert.equal(existsSync(marker), false);
});
