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
    fix: false,
    recheck: false,
  });
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
