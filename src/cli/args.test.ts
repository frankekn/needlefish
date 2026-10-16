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

test("parseArgs accepts local diff mode flags", () => {
  const uncommitted = parseArgs(["--uncommitted"]);
  assert.equal(uncommitted.kind, "local");
  if (uncommitted.kind === "local") {
    assert.equal(uncommitted.opts.localMode, "uncommitted");
  }

  const branch = parseArgs(["--branch"]);
  assert.equal(branch.kind, "local");
  if (branch.kind === "local") {
    assert.equal(branch.opts.localMode, "branch");
  }
});

test("parseArgs rejects mutually exclusive local diff mode flags", () => {
  assert.throws(() => parseArgs(["--uncommitted", "--branch"]), /--uncommitted cannot be combined with --branch/);
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
  const command = parseArgs(["--runner", "acp", "--model", "opus", "--timeout-ms", "1234"]);

  assert.equal(command.kind, "local");
  if (command.kind === "local") {
    assert.equal(command.opts.runner, "acp");
    assert.equal(command.opts.model, "opus");
    assert.equal(command.opts.timeoutMs, 1234);
  }
});

test("parseArgs treats spaced and inline value options equivalently", () => {
  const pairs = [
    [["--pr", "24"], ["--pr=24"]],
    [["--base", "main"], ["--base=main"]],
    [["--repo", "/tmp/repo"], ["--repo=/tmp/repo"]],
    [["--focus", "security"], ["--focus=security"]],
    [["--runner", "acp"], ["--runner=acp"]],
    [["--model", "opus"], ["--model=opus"]],
    [["--timeout-ms", "1234"], ["--timeout-ms=1234"]],
  ] as const;
  for (const [spaced, inline] of pairs) {
    assert.deepEqual(parseArgs(spaced), parseArgs(inline));
  }
  assert.deepEqual(
    parseArgs(["explain", "8", "--finding", "rounded seconds"]),
    parseArgs(["explain", "8", "--finding=rounded seconds"]),
  );
});

test("parseArgs validates runner options", () => {
  assert.throws(() => parseArgs(["--runner", "wat"]), /codex, claude, opencode, openai, grok, pi, acp/);
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

test("parseArgs accepts --dry-run and --print-bundle for local and pr modes", () => {
  const localCommand = parseArgs(["--dry-run"]);
  assert.equal(localCommand.kind, "local");
  if (localCommand.kind === "local") {
    assert.equal(localCommand.dryRun, true);
    assert.equal(localCommand.printBundle, false);
    assert.equal(localCommand.json, false);
  }

  const prCommand = parseArgs(["pr", "24", "--dry-run", "--print-bundle", "--json"]);
  assert.equal(prCommand.kind, "pr");
  if (prCommand.kind === "pr") {
    assert.equal(prCommand.dryRun, true);
    assert.equal(prCommand.printBundle, true);
    assert.equal(prCommand.json, true);
  }

  const normal = parseArgs(["--repo", "/tmp/repo"]);
  if (normal.kind === "local") {
    assert.equal(normal.dryRun, false);
    assert.equal(normal.printBundle, false);
  }
});

test("parseArgs rejects --print-bundle without --dry-run", () => {
  assert.throws(() => parseArgs(["--print-bundle"]), /--print-bundle requires --dry-run/);
  assert.throws(() => parseArgs(["pr", "24", "--print-bundle"]), /--print-bundle requires --dry-run/);
  assert.throws(() => parseArgs(["--github", "--pr", "1", "--print-bundle"]), /--print-bundle requires --dry-run/);
});

test("parseArgs rejects --dry-run in github and explain modes", () => {
  assert.throws(
    () => parseArgs(["--github", "--pr", "1", "--dry-run"]),
    /--dry-run is not supported with --github/,
  );
  assert.throws(
    () => parseArgs(["explain", "8", "--finding", "x", "--dry-run"]),
    /--dry-run is only valid in local and pr modes/,
  );
});

test("parseArgs parses render and verdict cached-result commands", () => {
  assert.deepEqual(parseArgs(["render", "/tmp/last-review.json"]), {
    kind: "render",
    file: "/tmp/last-review.json",
  });
  assert.deepEqual(parseArgs(["verdict", "r.json"]), {
    kind: "verdict",
    file: "r.json",
  });
  assert.deepEqual(parseArgs(["render", "--help"]), { kind: "help" });
});

test("parseArgs rejects render/verdict without exactly one file", () => {
  assert.throws(() => parseArgs(["render"]), /render requires a path/);
  assert.throws(() => parseArgs(["verdict"]), /verdict requires a path/);
  assert.throws(() => parseArgs(["render", "--json"]), /render requires a path/);
  assert.throws(
    () => parseArgs(["verdict", "a.json", "--repo", "."]),
    /verdict takes exactly one file argument/,
  );
});

test("parseArgs accepts the doctor command with its diagnostic options only", () => {
  assert.deepEqual(parseArgs(["doctor"]), { kind: "doctor", json: false });
  assert.deepEqual(parseArgs(["doctor", "--repo", "/tmp/repo", "--runner", "claude", "--base", "develop", "--json"]), {
    kind: "doctor",
    json: true,
    repo: "/tmp/repo",
    runner: "claude",
    base: "develop",
  });
  assert.deepEqual(parseArgs(["doctor", "--connection", "account-a", "--json"]), { kind: "doctor", connection: "account-a", json: true });
  assert.throws(() => parseArgs(["doctor", "--connection", "a", "--runner", "codex"]), /cannot be combined/);
  assert.deepEqual(parseArgs(["doctor", "--help"]), { kind: "help" });
  for (const flag of ["--deep", "--pr=1", "--github", "--dry-run", "--focus=x", "--model=m", "--uncommitted"]) {
    assert.throws(() => parseArgs(["doctor", flag]), /doctor accepts only --repo, --runner or --connection, --base, and --json/, flag);
  }
});

test("parseArgs preserves local setup preview and validates guided operations", () => {
  assert.deepEqual(parseArgs(["setup", "github"]), { kind: "setup-github" });
  assert.deepEqual(parseArgs(["setup", "github", "--repo=/tmp/a"]), { kind: "setup-github", repo: "/tmp/a" });
  assert.deepEqual(parseArgs(["setup", "github", "--repo", "/tmp/a"]), { kind: "setup-github", repo: "/tmp/a" });
  assert.throws(() => parseArgs(["setup"]), /requires the github subcommand/);
  assert.throws(() => parseArgs(["setup", "github", "--runner", "codex"]), /Unknown setup github option/);
  assert.throws(() => parseArgs(["setup", "github", "--repo", "a", "--repo", "b"]), /may only be supplied once/);
});


test("guided setup parser separates repository and effect confirmations", () => {
  assert.deepEqual(parseArgs(["setup", "github", "status", "--repository", "owner/repo", "--json"]), {
    kind: "setup-github", action: "status", repository: "owner/repo", json: true, confirm: false, replaceSecret: false,
  });
  for (const args of [["status"], ["repositories", "--repository", "a/b"], ["status", "--repo", "/tmp"], ["status", "--repository", "a/b", "--replace-secret"], ["--json"]]) {
    assert.throws(() => parseArgs(["setup", "github", ...args]));
  }
});


test("connections machine commands accept only one operation, JSON and repo", () => {
  for (const operation of ["list", "edit", "validate", "apply", "inspect"] as const) {
    assert.deepEqual(parseArgs(["connections", operation, "--json", "--repo=/fake/repo"]), { kind: "connections", operation, repo: "/fake/repo" });
  }
  for (const args of [["list"], ["review", "--json", "--repo", "/repo"], ["list", "--json", "--runner", "codex"], ["list", "--json", "--json"], ["list", "--json", "--repo=a", "--repo=b"]]) {
    assert.throws(() => parseArgs(["connections", ...args]));
  }
});
