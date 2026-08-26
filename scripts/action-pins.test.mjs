import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const SHA = /^[0-9a-f]{40}$/;
const VERSION_COMMENT = /^v\d+\.\d+\.\d+$/;
// Only hosted-review.yml is allowed to carry a floating first-party ref, and only the
// exact major tag its header comment documents as the deliberate live-test target
// (currently v0 — see .github/workflows/hosted-review.yml:1-5). Matching any `vN` here
// would silently follow a future major bump (or a typo) without anyone updating this
// test, defeating the point of an intentional, reviewed exemption. Bumping the major
// tag in hosted-review.yml must come with a matching bump here in the same PR.
const FIRST_PARTY_FLOATING = /^frankekn\/needlefish@v0$/;
const FIRST_PARTY_FLOATING_EXEMPT_FILE = join(".github/workflows", "hosted-review.yml");
const PINNED_RUNNER = /^(\d+)\.(\d+)\.(\d+)$/;

function workflowFiles() {
  return [
    "action.yml",
    join("setup", "action.yml"),
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

// Checks one `uses:` line against the pinning invariant. Returns `{ exempt: true }`
// for the hosted-review.yml floating first-party tag; otherwise asserts SHA+version
// comment and returns `{ exempt: false }`. Exported behavior only via return value so
// both the aggregate sweep test and the file-scoping unit tests exercise the same logic.
function assertPinned(file, use) {
  if (/^\.{1,2}\//.test(use.action)) return { exempt: false, local: true };
  if (file === FIRST_PARTY_FLOATING_EXEMPT_FILE && FIRST_PARTY_FLOATING.test(use.action)) {
    return { exempt: true };
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
  return { exempt: false };
}

test("third-party actions are SHA-pinned with a version comment", () => {
  let thirdParty = 0;
  let firstParty = 0;
  for (const file of workflowFiles()) {
    for (const use of usesLines(readFileSync(file, "utf8"))) {
      const { exempt, local } = assertPinned(file, use);
      if (local) continue;
      if (exempt) {
        firstParty += 1;
      } else {
        thirdParty += 1;
      }
    }
  }
  assert.ok(thirdParty > 0, "expected at least one third-party action pin");
  assert.ok(firstParty > 0, "expected the hosted live-test first-party floating ref");
});

test("floating first-party tag is exempt in hosted-review.yml", () => {
  const use = { line: 1, action: "frankekn/needlefish@v0", comment: "", raw: "uses: frankekn/needlefish@v0" };
  const result = assertPinned(FIRST_PARTY_FLOATING_EXEMPT_FILE, use);
  assert.deepEqual(result, { exempt: true });
});

test("floating first-party tag fails the invariant outside hosted-review.yml", () => {
  const use = { line: 1, action: "frankekn/needlefish@v1", comment: "", raw: "uses: frankekn/needlefish@v1" };
  assert.throws(
    () => assertPinned(join(".github/workflows", "deploy.yml"), use),
    /must be a 40-hex SHA/,
    "a floating first-party tag must not be silently exempted in a privileged workflow",
  );
});

test("a different floating major tag in hosted-review.yml is not silently exempted", () => {
  const use = { line: 1, action: "frankekn/needlefish@v1", comment: "", raw: "uses: frankekn/needlefish@v1" };
  assert.throws(
    () => assertPinned(FIRST_PARTY_FLOATING_EXEMPT_FILE, use),
    /must be a 40-hex SHA/,
    "only the documented v0 tag is exempt in hosted-review.yml; a major bump must update this test deliberately",
  );
});

test("local actions do not require an external ref pin", () => {
  const use = { line: 1, action: "./", comment: "", raw: "uses: ./" };
  assert.deepEqual(assertPinned("canary.yml", use), { exempt: false, local: true });
});

test("published actions share the runner catalog and expose an install opt-out", () => {
  const action = readFileSync("action.yml", "utf8");
  const setupAction = readFileSync(join("setup", "action.yml"), "utf8");
  const catalog = JSON.parse(readFileSync("runner-catalog.json", "utf8"));
  assert.doesNotMatch(action, /^\s+default:\s*latest\s*$/m);
  assert.match(action, /install_runner:\n[\s\S]*?default: "true"/);
  assert.match(action, /codex\|claude\|opencode\|pi\) ;;/);
  assert.match(action, /if: inputs\.install_runner == 'true'/);
  assert.match(action, /scripts\/setup-runner\.mjs/);
  assert.match(action, /"\$\{CODEX_BIN:-codex\}" login --with-api-key/);
  assert.match(setupAction, /\.\.\/scripts\/setup-runner\.mjs/);
  for (const text of [action, setupAction]) {
    assert.doesNotMatch(text, /@openai\/codex|@anthropic-ai\/claude-code|opencode-ai|@mariozechner\/pi/);
  }

  const pins = Object.fromEntries(
    Object.entries(catalog)
      .filter(([, entry]) => entry.hostedInstall)
      .map(([runner, entry]) => [runner, entry.hostedInstall]),
  );
  assert.deepEqual(
    Object.keys(pins).sort(),
    ["claude", "codex", "opencode", "pi"],
    "every hosted runner must have its own pin",
  );
  assert.equal(pins.codex.npmPackage, "@openai/codex");
  assert.equal(pins.claude.npmPackage, "@anthropic-ai/claude-code");
  assert.equal(pins.opencode.npmPackage, "opencode-ai");
  assert.equal(pins.pi.npmPackage, "@mariozechner/pi");
  for (const [runner, { defaultVersion }] of Object.entries(pins)) {
    assert.notEqual(defaultVersion, "latest", `${runner} must not pin latest`);
    assert.match(defaultVersion, PINNED_RUNNER, `${runner} pin must be x.y.z: ${defaultVersion}`);
  }
});
