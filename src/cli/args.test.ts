import assert from "node:assert/strict";
import test from "node:test";
import { parseArgs } from "./args";

test("parseArgs returns github command when pr is valid", () => {
  const argv = ["--github", "--pr", "123", "--repo", "/tmp/repo"];

  const command = parseArgs(argv);

  assert.deepEqual(command, {
    kind: "github",
    pr: 123,
    repo: "/tmp/repo",
    opts: {},
    fix: false,
    recheck: false,
  });
});

test("parseArgs separates pr command from --pr context", () => {
  const prCommand = parseArgs(["pr", "24", "--repo", "/tmp/repo", "--focus", "security"]);

  assert.equal(prCommand.kind, "pr");
  if (prCommand.kind === "pr") {
    assert.equal(prCommand.pr, 24);
    assert.equal(prCommand.repo, "/tmp/repo");
    assert.equal(prCommand.opts.focus, "security");
  }

  const contextCommand = parseArgs(["--pr", "24"]);

  assert.equal(contextCommand.kind, "local");
  if (contextCommand.kind === "local") {
    assert.equal(contextCommand.opts.pr, 24);
  }

  assert.deepEqual(parseArgs(["pr", "--help"]), { kind: "help" });
});

test("parseArgs accepts --json for local and pr modes", () => {
  const localCommand = parseArgs(["--repo", "/tmp/repo", "--json"]);

  assert.equal(localCommand.kind, "local");
  if (localCommand.kind === "local") {
    assert.equal(localCommand.json, true);
  }

  const prCommand = parseArgs(["pr", "24", "--repo", "/tmp/repo", "--json"]);

  assert.equal(prCommand.kind, "pr");
  if (prCommand.kind === "pr") {
    assert.equal(prCommand.json, true);
  }
});

test("parseArgs rejects --json in github mode", () => {
  assert.throws(() => parseArgs(["--github", "--pr", "1", "--json"]), /--json is not supported with --github/);
});

test("parseArgs rejects missing option values", () => {
  const argv = ["--base"];

  assert.throws(() => parseArgs(argv), /--base requires a value/);
});

test("parseArgs rejects invalid pr values", () => {
  const argv = ["--github", "--pr=0"];

  assert.throws(() => parseArgs(argv), /--pr requires a positive integer/);
});

test("parseArgs rejects unknown flags", () => {
  const argv = ["--wat"];

  assert.throws(() => parseArgs(argv), /unknown option --wat/);
});

test("parseArgs rejects empty inline option values", () => {
  assert.throws(() => parseArgs(["--repo="]), /--repo requires a value/);
  assert.throws(() => parseArgs(["--base="]), /--base requires a value/);
  assert.throws(() => parseArgs(["--focus="]), /--focus requires a value/);
});

test("parseArgs rejects local-only flags in github mode", () => {
  assert.throws(() => parseArgs(["--github", "--pr", "1", "--base", "main"]), /--base is only valid in local mode/);
  assert.throws(() => parseArgs(["--github", "--pr", "1", "--focus", "security"]), /--focus is only valid in local mode/);
  assert.throws(() => parseArgs(["--github", "--pr", "1", "--deep"]), /--deep is only valid in local mode/);
});

test("parseArgs accepts runner options", () => {
  const command = parseArgs(["--runner", "claude", "--model", "opus", "--timeout-ms", "1234"]);

  assert.equal(command.kind, "local");
  if (command.kind === "local") {
    assert.equal(command.opts.runner, "claude");
    assert.equal(command.opts.model, "opus");
    assert.equal(command.opts.timeoutMs, 1234);
  }
});

test("parseArgs validates runner options", () => {
  assert.throws(() => parseArgs(["--runner", "wat"]), /--runner must be one of/);
  assert.throws(() => parseArgs(["--timeout-ms", "0"]), /--timeout-ms requires a positive integer/);
});

test("parseArgs parses explain command", () => {
  const cmd = parseArgs(["explain", "8", "--finding", "rounded seconds"]);
  assert.equal(cmd.kind, "explain");
  if (cmd.kind === "explain") {
    assert.equal(cmd.pr, 8);
    assert.equal(cmd.finding, "rounded seconds");
  }
});

test("parseArgs rejects explain without --finding", () => {
  assert.throws(() => parseArgs(["explain", "8"]), /explain requires --finding/);
});

test("parseArgs rejects --finding outside explain", () => {
  assert.throws(() => parseArgs(["--finding", "x"]), /only valid with the explain command/);
});
