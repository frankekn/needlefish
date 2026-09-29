import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runDoctor, renderDoctorReport, type DoctorCheck, type DoctorReport } from "./doctor";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures";
import { captureEnv, restoreEnv } from "../shared/runner-test-fixtures";

const ENV_KEYS = [
  "PATH",
  "CODEX_BIN",
  "CLAUDE_BIN",
  "OPENCODE_BIN",
  "NEEDLEFISH_RUNNER",
  "NEEDLEFISH_ACP_BIN",
  "OPENAI_API_KEY",
] as const;

type Fixture = {
  readonly tmp: string;
  readonly repo: string;
  readonly bin: string;
};

// A temp repo on a feature branch ahead of main, and an empty bin dir that
// becomes the whole PATH (plus node, which bin/needlefish needs).
function setup(t: TestContext): Fixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-doctor-test-"));
  const repo = initRepo(tmp);
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, path.join(bin, "node"));
  const previous = captureEnv(ENV_KEYS);
  t.after(() => {
    restoreEnv(previous);
    rmSync(tmp, { recursive: true, force: true });
  });
  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  writeFileSync(path.join(repo, "app.ts"), "export const x = 1;\n");
  commitAll(repo, "feature");
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.PATH = `${bin}:/usr/bin:/bin`;
  return { tmp, repo, bin };
}

function stub(bin: string, name: string, body: string): string {
  const file = path.join(bin, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
  return file;
}

function codexStub(bin: string, statusExit: number, statusText: string): string {
  return stub(
    bin,
    "codex",
    [
      'case "$1" in',
      '  --version) echo "codex-cli 9.9.9-stub"; exit 0 ;;',
      `  login) [ "$2" = status ] && { echo ${JSON.stringify(statusText)}; exit ${statusExit}; } ;;`,
      "esac",
      'echo "unexpected: $*" >&2; exit 99',
    ].join("\n"),
  );
}

function check(report: DoctorReport, name: DoctorCheck["name"]): DoctorCheck {
  const found = report.checks.find((entry) => entry.name === name);
  assert.ok(found, `missing ${name} check`);
  return found;
}

test("doctor passes with a logged-in runner on PATH and a detectable base", (t) => {
  const f = setup(t);
  const codex = codexStub(f.bin, 0, "Logged in using ChatGPT");

  const report = runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(report.ok, true);
  assert.equal(report.needlefish, "0.0.0-test");
  assert.deepEqual(
    report.checks.map((entry) => [entry.name, entry.status]),
    [["node", "ok"], ["runner", "ok"], ["auth", "ok"], ["git", "ok"], ["base", "ok"]],
  );
  assert.equal(check(report, "runner").detail, `codex (auto-detected; ${codex}, codex-cli 9.9.9-stub)`);
  assert.equal(check(report, "auth").detail, "codex: Logged in using ChatGPT");
  assert.match(check(report, "git").detail, /\(branch feature, clean\)$/);
  assert.equal(check(report, "base").detail, `main (merge-base ${gitText(["rev-parse", "main"], f.repo).slice(0, 7)})`);
  assert.equal(report.checks.some((entry) => entry.fix !== undefined), false);
});

test("doctor fails the auth check with the runner's login command when its status probe exits nonzero", (t) => {
  const f = setup(t);
  codexStub(f.bin, 1, "Not logged in");

  const report = runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(report.ok, false);
  assert.deepEqual(check(report, "auth"), {
    name: "auth",
    status: "fail",
    detail: "codex: Not logged in",
    fix: "Run `codex login`.",
  });
  assert.match(renderDoctorReport(report), /^fail {4}auth {4}codex: Not logged in\n {16}fix: Run `codex login`\.\n/m);
  assert.match(renderDoctorReport(report), /\n4 passed, 0 unknown, 1 failed\n$/);
});

test("doctor mirrors the review's mode choice: a dirty worktree needs no base ref", (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");
  gitText(["branch", "-M", "main", "trunk"], f.repo);
  writeFileSync(path.join(f.repo, "app.ts"), "export const x = 2;\n");

  const report = runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.deepEqual(check(report, "base"), {
    name: "base",
    status: "ok",
    detail: "not needed: worktree has uncommitted changes, so a review covers uncommitted changes",
  });
  assert.equal(report.ok, true);
  const cli = spawnSync(path.join(process.cwd(), "bin", "needlefish"), ["doctor", "--repo", f.repo], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(cli.status, 0, cli.stderr);

  gitText(["checkout", "--", "app.ts"], f.repo);
  const clean = runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.equal(check(clean, "base").status, "fail", "a clean worktree reviews merge-base..HEAD and needs the base");
});

test("doctor fails the runner check with install commands when no runner is on PATH", (t) => {
  const f = setup(t);

  const report = runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(report.ok, false);
  assert.deepEqual(check(report, "runner"), {
    name: "runner",
    status: "fail",
    detail: "No supported model runner found on PATH.",
    fix: [
      "Install one:",
      "  codex: npm install -g @openai/codex",
      "  claude: npm install -g @anthropic-ai/claude-code",
      "  opencode: npm install -g @opencode/cli",
    ].join("\n"),
  });
  assert.deepEqual(check(report, "auth"), { name: "auth", status: "unknown", detail: "skipped: no runner available" });
});

test("doctor reads opencode's credential list and fails when it is empty", (t) => {
  const f = setup(t);
  const script = (json: string) =>
    [
      'case "$1" in',
      '  --version) echo "opencode v9.9.9-stub"; exit 0 ;;',
      `  auth) [ "$2 $3 $4 $5" = "list --standalone --format json" ] && { echo '${json}'; exit 0; } ;;`,
      "esac",
      'echo "unexpected: $*" >&2; exit 99',
    ].join("\n");
  process.env.NEEDLEFISH_RUNNER = "opencode";

  stub(f.bin, "opencode", script("[]"));
  const empty = runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.deepEqual(check(empty, "auth"), {
    name: "auth",
    status: "fail",
    detail: "opencode: no provider credentials stored",
    fix: "Run `opencode auth login`.",
  });

  stub(f.bin, "opencode", script('[{"id":"openai","connections":[{}]}]'));
  const stored = runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.deepEqual(check(stored, "auth"), {
    name: "auth",
    status: "ok",
    detail: "opencode: 1 provider credential(s) stored",
  });
  assert.equal(check(stored, "runner").detail, `opencode (NEEDLEFISH_RUNNER; ${path.join(f.bin, "opencode")}, opencode v9.9.9-stub)`);
});

test("doctor reports unknown, not a guess, when a runner has no status command or the probe misbehaves", (t) => {
  const f = setup(t);
  stub(f.bin, "grok", 'case "$1" in --version) echo "grok 1.0-stub"; exit 0 ;; esac; exit 99');
  const grok = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "grok" });
  assert.deepEqual(check(grok, "auth"), {
    name: "auth",
    status: "unknown",
    detail: "grok: no login status command known; `grok login` signs in",
  });
  assert.equal(grok.ok, true, "unknown must not fail the report");
  assert.match(renderDoctorReport(grok), /\n4 passed, 1 unknown, 0 failed\n$/);
  assert.doesNotMatch(renderDoctorReport(grok), /all checks passed/);

  stub(f.bin, "opencode", 'echo "not json"; exit 0');
  const garbled = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "opencode" });
  assert.deepEqual(check(garbled, "auth"), {
    name: "auth",
    status: "unknown",
    detail: "opencode: `opencode auth list --standalone --format json` did not print JSON",
  });
});

test("doctor names the env var when an explicitly selected runner binary is missing", (t) => {
  const f = setup(t);
  process.env.CLAUDE_BIN = path.join(f.tmp, "missing-claude");

  const report = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "claude" });

  assert.deepEqual(check(report, "runner"), {
    name: "runner",
    status: "fail",
    detail: `claude: ${path.join(f.tmp, "missing-claude")} not found on PATH`,
    fix: "Install it with `npm install -g @anthropic-ai/claude-code`, or set CLAUDE_BIN to its executable.",
  });

  const acp = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "acp" });
  assert.deepEqual(check(acp, "runner"), {
    name: "runner",
    status: "fail",
    detail: "acp: NEEDLEFISH_ACP_BIN is not set",
    fix: "Set NEEDLEFISH_ACP_BIN to the acp executable.",
  });

  const agent = stub(f.bin, "acp-agent", "exit 0");
  process.env.NEEDLEFISH_ACP_BIN = ` ${agent} \n`;
  const padded = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "acp" });
  assert.equal(check(padded, "runner").detail, `acp (--runner; ${agent})`, "trimmed like runAcp reads it");
});

test("doctor checks OPENAI_API_KEY for the HTTP runner without any network call", (t) => {
  const f = setup(t);

  const missing = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "openai" });
  assert.equal(check(missing, "runner").detail, "openai (HTTP runner, no CLI)");
  assert.deepEqual(check(missing, "auth"), {
    name: "auth",
    status: "fail",
    detail: "openai: OPENAI_API_KEY is not set",
    fix: "Set OPENAI_API_KEY.",
  });

  process.env.OPENAI_API_KEY = "sk-test";
  const present = runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "openai" });
  assert.equal(check(present, "auth").status, "ok");
  assert.doesNotMatch(JSON.stringify(present), /sk-test/);
});

test("doctor explains git and base failures with the fix", (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");

  const notRepo = runDoctor({ repo: f.tmp, version: "0.0.0-test" });
  assert.deepEqual(check(notRepo, "git"), {
    name: "git",
    status: "fail",
    detail: `${f.tmp} is not a git repository`,
    fix: "Run `git init` inside your project folder.",
  });
  assert.deepEqual(check(notRepo, "base"), { name: "base", status: "unknown", detail: "skipped: not a git repository" });

  const badBase = runDoctor({ repo: f.repo, version: "0.0.0-test", base: "develop" });
  assert.deepEqual(check(badBase, "base"), {
    name: "base",
    status: "fail",
    detail: "develop: git merge-base develop HEAD failed: fatal: Not a valid object name develop",
    fix: "Pass --base <ref> to name the branch to compare against.",
  });

  gitText(["branch", "-M", "main", "trunk"], f.repo);
  const noMain = runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.equal(check(noMain, "base").status, "fail");
  assert.match(check(noMain, "base").detail, /^main: git merge-base main HEAD failed/);

  const fresh = path.join(f.tmp, "fresh");
  mkdirSync(fresh);
  gitText(["init", "-b", "main"], fresh);
  const noCommits = runDoctor({ repo: fresh, version: "0.0.0-test" });
  assert.equal(check(noCommits, "git").detail, `${fresh} (branch main, clean, no commits yet)`);
  assert.equal(check(noCommits, "base").detail, "not needed: no commits yet, so a review covers uncommitted changes");
  assert.equal(noCommits.ok, true);
});

test("bin/needlefish doctor exits 1 and prints JSON for a failed check", (t) => {
  const f = setup(t);
  codexStub(f.bin, 1, "Not logged in");
  const cli = path.join(process.cwd(), "bin", "needlefish");

  const failed = spawnSync(cli, ["doctor", "--repo", f.repo, "--json"], { encoding: "utf8", env: process.env });
  assert.equal(failed.status, 1, failed.stderr);
  const parsed: unknown = JSON.parse(failed.stdout);
  assert.ok(typeof parsed === "object" && parsed !== null);
  const report = parsed as DoctorReport;
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.ok, false);
  assert.equal(check(report, "auth").fix, "Run `codex login`.");

  codexStub(f.bin, 0, "Logged in using ChatGPT");
  const passed = spawnSync(cli, ["doctor", "--repo", f.repo], { encoding: "utf8", env: process.env });
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /^needlefish \d+\.\d+\.\d+/);
  assert.match(passed.stdout, /\nall checks passed\n$/);
});
