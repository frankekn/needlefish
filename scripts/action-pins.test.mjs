import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;
const FIRST_PARTY_FLOATING = /^frankekn\/needlefish@v\d+$/;
const PINNED_RUNNER = /^(\d+)\.(\d+)\.(\d+)$/;

function workflowFiles() {
  return [
    "action.yml",
    ...readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml"))
      .map((name) => join(".github/workflows", name)),
  ];
}

function usesLines(text) {
  const found = [];
  for (const [index, line] of text.split("\n").entries()) {
    const match = line.match(/^\s+(?:-\s+)?uses:\s+(\S+)(?:\s+#\s+(\S+))?\s*$/);
    if (!match) continue;
    found.push({
      line: index + 1,
      action: match[1],
      comment: match[2] ?? "",
      raw: line.trim(),
    });
  }
  return found;
}

test("third-party actions are SHA-pinned with a version comment", () => {
  let thirdParty = 0;
  let firstParty = 0;
  for (const file of workflowFiles()) {
    for (const use of usesLines(readFileSync(file, "utf8"))) {
      if (FIRST_PARTY_FLOATING.test(use.action)) {
        firstParty += 1;
        continue;
      }
      const at = use.action.lastIndexOf("@");
      assert.notEqual(at, -1, `${file}:${use.line} missing @ref: ${use.raw}`);
      const ref = use.action.slice(at + 1);
      assert.match(
        ref,
        SHA,
        `${file}:${use.line} third-party action must be a 40-hex SHA: ${use.raw}`,
      );
      assert.match(
        use.comment,
        VERSION_COMMENT,
        `${file}:${use.line} SHA pin must have a # vX.Y.Z comment: ${use.raw}`,
      );
      thirdParty += 1;
    }
  }
  assert.ok(thirdParty > 0, "expected at least one third-party action pin");
  assert.ok(firstParty > 0, "expected the hosted live-test first-party floating ref");
});

test("hosted action pins a version per runner and lets runner_version override", () => {
  const action = readFileSync("action.yml", "utf8");
  assert.doesNotMatch(action, /^\s+default:\s*latest\s*$/m);
  assert.match(
    action,
    /ver="\$\{NF_RUNNER_VERSION:-\$pinned\}"/,
    "install step must prefer runner_version when set",
  );
  assert.match(action, /npm install -g "\$\{pkg\}@\$\{ver\}"/);

  const pins = {};
  for (const match of action.matchAll(
    /^\s+(codex|claude|opencode|pi)\) pkg="([^"]+)"; pinned="([^"]+)" ;;$/gm,
  )) {
    pins[match[1]] = { pkg: match[2], pinned: match[3] };
  }
  assert.deepEqual(
    Object.keys(pins).sort(),
    ["claude", "codex", "opencode", "pi"],
    "every hosted runner must have its own pin",
  );
  assert.equal(pins.codex.pkg, "@openai/codex");
  assert.equal(pins.claude.pkg, "@anthropic-ai/claude-code");
  assert.equal(pins.opencode.pkg, "opencode-ai");
  assert.equal(pins.pi.pkg, "@mariozechner/pi");
  for (const [runner, { pinned }] of Object.entries(pins)) {
    assert.notEqual(pinned, "latest", `${runner} must not pin latest`);
    assert.match(pinned, PINNED_RUNNER, `${runner} pin must be x.y.z: ${pinned}`);
  }
});
