import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./args.js";

for (const prefix of [[], ["pr", "7"], ["--github", "--pr", "7"], ["explain", "7", "--finding", "bug"]]) {
  test(`connection selector is retained by ${prefix[0] ?? "local"}`, () => {
    for (const selector of [["--connection", "我的連線"], ["--connection=我的連線"]]) {
      const command = parseArgs([...prefix, ...selector, "--timeout-ms", "1000"]);
      assert.ok("opts" in command);
      assert.deepEqual(command.opts, { connection: "我的連線", timeoutMs: 1000 });
    }
  });
}

for (const conflict of [["--runner", "claude"], ["--runner=codex"], ["--model", "other"], ["--model=other"]]) {
  test(`connection rejects ${conflict[0]} in either argument order`, () => {
    assert.throws(() => parseArgs(["--connection", "a", ...conflict]), /cannot be combined/);
    assert.throws(() => parseArgs([...conflict, "--connection=a"]), /cannot be combined/);
  });
}

test("missing or duplicate connection selectors fail", () => {
  assert.throws(() => parseArgs(["--connection"]), /requires a value/);
  assert.throws(() => parseArgs(["--connection="]), /requires a value/);
  assert.throws(() => parseArgs(["--connection=a", "--connection", "b"]), /only be supplied once/);
});

test("help, version and legacy options do not select a connection", () => {
  assert.deepEqual(parseArgs(["--help"]), { kind: "help" });
  assert.deepEqual(parseArgs(["--version"]), { kind: "version" });
  const command = parseArgs(["--runner", "claude", "--model", "legacy"]);
  assert.ok("opts" in command);
  assert.deepEqual(command.opts, { runner: "claude", model: "legacy" });
});
