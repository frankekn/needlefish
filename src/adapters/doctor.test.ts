import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { runDoctor, renderDoctorReport, type DoctorCheck, type DoctorReport } from "./doctor";
import { runCodex } from "../shared/codex";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";
import { RUNNER_DEFINITIONS, RUNNERS } from "../shared/runner";
import { captureEnv, restoreEnv } from "../shared/runner-test-fixtures";

const ENV_KEYS = [
  "PATH",
  "CODEX_BIN",
  "CLAUDE_BIN",
  "OPENCODE_BIN",
  "NEEDLEFISH_RUNNER",
  "NEEDLEFISH_ACP_BIN",
  "GROK_BIN",
  "PI_BIN",
  "NEEDLEFISH_NO_RETRY",
  "LC_ALL",
  "LANGUAGE",
  "GIT_TEST_ASSUME_DIFFERENT_OWNER",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "OPENAI_API_KEY",
  "NEEDLEFISH_RUNNER_ENV_PASSTHROUGH",
  "CODEX_API_KEY",
  "CODEX_PROXY_BASE_URL",
  "CODEX_PROXY_API_KEY",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "GROK_API_KEY",
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

test("doctor passes with a logged-in runner on PATH and a detectable base", async (t) => {
  const f = setup(t);
  const codex = codexStub(f.bin, 0, "Logged in using ChatGPT");

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(report.ok, true);
  assert.equal(report.needlefish, "0.0.0-test");
  assert.deepEqual(
    report.checks.map((entry) => [entry.name, entry.status]),
    [["node", "ok"], ["runner", "ok"], ["capability", "ok"], ["auth", "ok"], ["git", "ok"], ["base", "ok"]],
  );
  assert.equal(check(report, "runner").detail, `codex (auto-detected; ${codex}, codex-cli 9.9.9-stub)`);
  assert.equal(check(report, "auth").detail, "codex: Logged in using ChatGPT");
  assert.match(check(report, "git").detail, /\(branch feature, clean\)$/);
  assert.equal(check(report, "base").detail, `main (merge-base ${gitText(["rev-parse", "main"], f.repo).slice(0, 7)})`);
  assert.equal(report.checks.some((entry) => entry.fix !== undefined), false);
});

test("doctor fails the auth check with the runner's login command when its status probe exits nonzero", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 1, "Not logged in");

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(report.ok, false);
  assert.deepEqual(check(report, "auth"), {
    name: "auth",
    status: "fail",
    detail: "codex: Not logged in",
    fix: "Run `codex login`.",
  });
  assert.match(renderDoctorReport(report), /^fail {4}auth {4}codex: Not logged in\n {16}fix: Run `codex login`\.\n/m);
  assert.match(renderDoctorReport(report), /\n5 passed, 0 unknown, 1 failed\n$/);
});

test("doctor mirrors the review's mode choice: a dirty worktree needs no base ref", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");
  gitText(["branch", "-M", "main", "trunk"], f.repo);
  writeFileSync(path.join(f.repo, "app.ts"), "export const x = 2;\n");

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test" });

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
  const clean = await runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.equal(check(clean, "base").status, "fail", "a clean worktree reviews merge-base..HEAD and needs the base");
});

test("doctor fails the runner check with install commands when no runner is on PATH", async (t) => {
  const f = setup(t);

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test" });

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

test("doctor reads opencode's credential list and fails when it is empty", async (t) => {
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
  const empty = await runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.deepEqual(check(empty, "auth"), {
    name: "auth",
    status: "fail",
    detail: "opencode: no provider credentials stored",
    fix: "Run `opencode auth login`.",
  });

  stub(f.bin, "opencode", script('[{"id":"openai","connections":[{}]}]'));
  const stored = await runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.deepEqual(check(stored, "auth"), {
    name: "auth",
    status: "ok",
    detail: "opencode: 1 provider credential(s) stored",
  });
  assert.equal(check(stored, "runner").detail, `opencode (NEEDLEFISH_RUNNER; ${path.join(f.bin, "opencode")}, opencode v9.9.9-stub)`);
});

test("doctor reports unknown, not a guess, when a runner has no status command or the probe misbehaves", async (t) => {
  const f = setup(t);
  stub(f.bin, "grok", 'case "$1" in --version) echo "grok 1.0-stub"; exit 0 ;; esac; exit 99');
  const grok = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "grok" });
  assert.deepEqual(check(grok, "auth"), {
    name: "auth",
    status: "unknown",
    detail: "grok: no login status command known; `grok login` signs in",
  });
  assert.equal(grok.ok, true, "unknown must not fail the report");
  assert.match(renderDoctorReport(grok), /\n5 passed, 1 unknown, 0 failed\n$/);
  assert.doesNotMatch(renderDoctorReport(grok), /all checks passed/);

  stub(f.bin, "opencode", 'echo "not json"; exit 0');
  const garbled = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "opencode" });
  assert.deepEqual(check(garbled, "auth"), {
    name: "auth",
    status: "unknown",
    detail: "opencode: `opencode auth list --standalone --format json` did not print JSON",
  });
});

test("doctor names the env var when an explicitly selected runner binary is missing", async (t) => {
  const f = setup(t);
  process.env.CLAUDE_BIN = path.join(f.tmp, "missing-claude");

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "claude" });

  assert.deepEqual(check(report, "runner"), {
    name: "runner",
    status: "fail",
    detail: `claude: ${path.join(f.tmp, "missing-claude")} not found on PATH`,
    fix: "Install it with `npm install -g @anthropic-ai/claude-code`, or set CLAUDE_BIN to its executable.",
  });

  const acp = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "acp" });
  assert.deepEqual(check(acp, "runner"), {
    name: "runner",
    status: "fail",
    detail: "acp: NEEDLEFISH_ACP_BIN is not set",
    fix: "Set NEEDLEFISH_ACP_BIN to the acp executable.",
  });

  const agent = stub(f.bin, "acp-agent", "exit 0");
  process.env.NEEDLEFISH_ACP_BIN = ` ${agent} \n`;
  const padded = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "acp" });
  assert.equal(check(padded, "runner").detail, `acp (--runner; ${agent})`, "trimmed like runAcp reads it");
});

// Issue #201 item 1: detection, the doctor, and every spawn site read *_BIN
// through one function, so the doctor's runner verdict is the review's spawn
// outcome whatever shape the override takes.
test("doctor's runner verdict equals whether the review spawns, for every CLI runner and override shape", async (t) => {
  const f = setup(t);
  process.env.NEEDLEFISH_NO_RETRY = "1";
  const marker = path.join(f.tmp, "spawned");
  for (const runner of RUNNERS) {
    const bin = RUNNER_DEFINITIONS[runner].bin;
    if (bin === undefined) continue;
    const executable = stub(f.bin, runner, `touch ${JSON.stringify(marker)}`);
    const shapes = {
      padded: ` ${executable} \n`,
      empty: "",
      whitespace: "  ",
      "missing-name": `missing-${runner}`,
      "missing-path": path.join(f.tmp, "missing"),
    };
    for (const [shape, value] of Object.entries(shapes)) {
      process.env[bin.env] = value;
      const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner });
      rmSync(marker, { force: true });
      await runCodex("prompt", { runner, repoPath: f.repo, targetHeadSha: headSha(f.repo), timeoutMs: 5000 }).catch(() => undefined);
      assert.equal(check(report, "runner").status === "ok", existsSync(marker), `${runner} with ${shape} ${bin.env}`);
    }
    delete process.env[bin.env];
  }
});

test("doctor checks OPENAI_API_KEY for the HTTP runner without any network call", async (t) => {
  const f = setup(t);

  const missing = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "openai" });
  assert.equal(check(missing, "runner").detail, "openai (HTTP runner, no CLI)");
  assert.deepEqual(check(missing, "auth"), {
    name: "auth",
    status: "fail",
    detail: "openai: OPENAI_API_KEY is not set",
    fix: "Set OPENAI_API_KEY.",
  });

  process.env.OPENAI_API_KEY = "sk-test";
  const present = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "openai" });
  assert.equal(check(present, "auth").status, "ok");
  assert.doesNotMatch(JSON.stringify(present), /sk-test/);
});

test("doctor explains git and base failures with the fix", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");

  const notRepo = await runDoctor({ repo: f.tmp, version: "0.0.0-test" });
  assert.deepEqual(check(notRepo, "git"), {
    name: "git",
    status: "fail",
    detail: `${f.tmp} is not a git repository`,
    fix: "Run `git init` inside your project folder.",
  });
  assert.deepEqual(check(notRepo, "base"), { name: "base", status: "unknown", detail: "skipped: git check failed" });

  const badBase = await runDoctor({ repo: f.repo, version: "0.0.0-test", base: "develop" });
  assert.deepEqual(check(badBase, "base"), {
    name: "base",
    status: "fail",
    detail: "develop: git merge-base develop HEAD failed: fatal: Not a valid object name develop",
    fix: "Pass --base <ref> to name the branch to compare against.",
  });

  gitText(["branch", "-M", "main", "trunk"], f.repo);
  const noMain = await runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.equal(check(noMain, "base").status, "fail");
  assert.match(check(noMain, "base").detail, /^main: git merge-base main HEAD failed/);

  const fresh = path.join(f.tmp, "fresh");
  mkdirSync(fresh);
  gitText(["init", "-b", "main"], fresh);
  const noCommits = await runDoctor({ repo: fresh, version: "0.0.0-test" });
  assert.equal(check(noCommits, "git").detail, `${fresh} (branch main, clean, no commits yet)`);
  assert.equal(check(noCommits, "base").detail, "not needed: no commits yet, so a review covers uncommitted changes");
  assert.equal(noCommits.ok, true);
});

// Issue #201 item 2: isGitRepo mapped every failure to "not a repo", so a
// missing path, a missing git, and git's own refusal all printed `git init`.
test("doctor tells git failures apart from a missing repository, with a matching fix", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");

  const missing = path.join(f.tmp, "missing");
  assert.deepEqual(check(await runDoctor({ repo: missing, version: "0.0.0-test" }), "git"), {
    name: "git",
    status: "fail",
    detail: `${missing} does not exist`,
    fix: "Check the --repo path.",
  });

  const refusal = `fatal: detected dubious ownership in repository at '${f.repo}'`;
  const fakeGit = stub(f.bin, "git", `echo ${JSON.stringify(refusal)} >&2; exit 128`);
  const refused = await runDoctor({ repo: f.repo, version: "0.0.0-test" });
  assert.deepEqual(check(refused, "git"), {
    name: "git",
    status: "fail",
    detail: refusal,
    fix: `Run \`git config --global --add safe.directory '${f.repo}'\`.`,
  });
  assert.deepEqual(check(refused, "base"), { name: "base", status: "unknown", detail: "skipped: git check failed" });
  rmSync(fakeGit);

  process.env.PATH = f.bin;
  assert.deepEqual(check(await runDoctor({ repo: f.repo, version: "0.0.0-test" }), "git"), {
    name: "git",
    status: "fail",
    detail: "git is not installed or not on PATH",
    fix: "Install git.",
  });
});

// git translates its messages; the probe must read them in one locale. The stub
// answers in German unless it is asked in C, the way a real localized git would.
test("doctor recognizes a non-repository under a non-English locale", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");
  stub(
    f.bin,
    "git",
    [
      'if [ "$LC_ALL" = C ] && [ -z "$LANGUAGE" ]; then',
      '  echo "fatal: not a git repository (or any of the parent directories): .git" >&2',
      "else",
      '  echo "fatal: Kein Git-Repository (oder irgendeines der Elternverzeichnisse): .git" >&2',
      "fi",
      "exit 128",
    ].join("\n"),
  );
  process.env.LC_ALL = "de_DE.UTF-8";
  process.env.LANGUAGE = "de";

  assert.deepEqual(check(await runDoctor({ repo: f.tmp, version: "0.0.0-test" }), "git"), {
    name: "git",
    status: "fail",
    detail: `${f.tmp} is not a git repository`,
    fix: "Run `git init` inside your project folder.",
  });
});

// git checks ownership of the repository root it names in stderr, not of the
// --repo path, so the suggested safe.directory must be that root, quoted so a
// path with a space survives the shell. Hosted CI images allow every directory
// in their system gitconfig; the probe drops global and system config so git's
// own ownership test hook refuses the repository.
test("doctor's safe.directory fix names and quotes the repository root git refused", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");
  mkdirSync(path.join(f.tmp, "with space"));
  const repo = realpathSync(initRepo(path.join(f.tmp, "with space")));
  const sub = path.join(repo, "sub");
  mkdirSync(sub);
  const globalConfig = path.join(f.tmp, "gitconfig");
  process.env.GIT_TEST_ASSUME_DIFFERENT_OWNER = "1";
  process.env.GIT_CONFIG_GLOBAL = globalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  const probe = () =>
    spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: sub, encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const before = probe();
  if (before.status !== 128 || !/dubious ownership/.test(before.stderr)) {
    const version = spawnSync("git", ["--version"], { encoding: "utf8" }).stdout.trim();
    t.skip(`${version} ignores GIT_TEST_ASSUME_DIFFERENT_OWNER: exit ${before.status}, ${before.stderr.trim()}`);
    return;
  }

  const report = await runDoctor({ repo: sub, version: "0.0.0-test" });
  assert.deepEqual(check(report, "git"), {
    name: "git",
    status: "fail",
    detail: `fatal: detected dubious ownership in repository at '${repo}'`,
    fix: `Run \`git config --global --add safe.directory '${repo}'\`.`,
  });

  const command = check(report, "git").fix?.match(/`(.+)`/)?.[1];
  assert.ok(command);
  const applied = spawnSync("bash", ["-c", command], { encoding: "utf8", env: process.env });
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(probe().stdout.trim(), "true", "the printed command clears the refusal");
});

test("bin/needlefish doctor exits 1 and prints JSON for a failed check", async (t) => {
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

// The review accepts these env-credential modes without the CLI's own
// credential store (hasRunnerEnvCredential), so the doctor must too.
test("doctor accepts env-credential setups the review accepts, without printing the value", async (t) => {
  const f = setup(t);
  const secret = "s3cret-value-9f1c";
  codexStub(f.bin, 1, "Not logged in");
  stub(f.bin, "claude", 'case "$1" in --version) echo "1.0-stub"; exit 0 ;; esac; echo "Not logged in"; exit 1');
  stub(f.bin, "opencode", 'case "$1" in --version) echo "opencode 1.0-stub"; exit 0 ;; esac; echo "[]"; exit 0');
  stub(f.bin, "grok", 'case "$1" in --version) echo "grok 1.0-stub"; exit 0 ;; esac; exit 99');
  const accepted = async (runner: "codex" | "claude" | "opencode" | "grok", env: Record<string, string>) => {
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner });
    for (const key of Object.keys(env)) delete process.env[key];
    assert.deepEqual(
      check(report, "auth"),
      { name: "auth", status: "ok", detail: `${runner}: env credential configured; CLI login state not probed` },
      `${runner} with ${Object.keys(env).join(",")}`,
    );
    assert.equal(report.ok, true);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(secret));
  };
  await accepted("opencode", { OPENAI_API_KEY: secret });
  await accepted("opencode", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "ZAI_API_KEY", ZAI_API_KEY: secret });
  await accepted("codex", { CODEX_PROXY_BASE_URL: "http://127.0.0.1:1", CODEX_PROXY_API_KEY: secret });
  await accepted("codex", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "CODEX_API_KEY", CODEX_API_KEY: secret });
  await accepted("claude", { ANTHROPIC_API_KEY: secret });
  await accepted("claude", { CLAUDE_CODE_OAUTH_TOKEN: secret });
  await accepted("grok", { NEEDLEFISH_RUNNER_ENV_PASSTHROUGH: "GROK_API_KEY", GROK_API_KEY: secret });

  // Without the env credential the same stubs are judged by their own status.
  assert.equal(check(await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "opencode" }), "auth").status, "fail");
  assert.equal(check(await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "codex" }), "auth").status, "fail");
  // A passthrough name alone is configuration, not a credential.
  process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH = "CODEX_API_KEY";
  assert.equal(check(await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "codex" }), "auth").status, "fail");
});

// A status probe must never run inside the repository: `opencode auth list
// --standalone` starts a server that reads the working tree and .git objects
// of its cwd, and claude reads .git/config.
test("doctor runs every runner probe in an empty temp dir, not the repository", async (t) => {
  const f = setup(t);
  const seen = path.join(f.tmp, "probe-cwds.txt");
  stub(
    f.bin,
    "codex",
    [
      `pwd >> ${JSON.stringify(seen)}`,
      'case "$1" in',
      '  --version) echo "codex-cli 9.9.9-stub"; exit 0 ;;',
      '  login) echo "Logged in"; exit 0 ;;',
      "esac",
      "exit 99",
    ].join("\n"),
  );

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(check(report, "auth").status, "ok");
  const cwds = readFileSync(seen, "utf8").trim().split("\n");
  assert.equal(cwds.length, 2, "one --version probe and one status probe");
  for (const cwd of cwds) {
    assert.notEqual(cwd, f.repo);
    assert.ok(cwd.startsWith(os.tmpdir()), cwd);
    assert.ok(path.basename(cwd).startsWith("needlefish-doctor-"), cwd);
    assert.equal(existsSync(cwd), false, "probe dir is removed after the report");
  }
  assert.equal(cwds[0], cwds[1]);
});

test("doctor reports HTTP review capability as unsupported even with a configured credential", async (t) => {
  const f = setup(t);
  process.env.OPENAI_API_KEY = "local-test-placeholder";
  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "openai" });
  assert.equal(report.ok, false);
  const capability = report.checks.find((entry) => entry.name === "capability");
  assert.equal(capability?.status, "fail");
  assert.match(capability?.detail ?? "", /unsupported-capability.*repositoryRead/);
  assert.match(renderDoctorReport(report), /fail {4}capability unsupported-capability/);
});

test("doctor marks an arbitrary ACP launcher repository capability unknown", async (t) => {
  const f = setup(t);
  process.env.NEEDLEFISH_ACP_BIN = stub(f.bin, "acp-agent", "exit 0");
  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "acp" });
  const capability = report.checks.find((entry) => entry.name === "capability");
  assert.equal(capability?.status, "unknown");
  assert.match(capability?.detail ?? "", /unknown.*initialize.*repositoryRead/);
});

for (const stalledCommand of ["--version", "login"]) {
  test(`doctor hard-stops a signal-trapping ${stalledCommand} probe and its descendants`, { skip: process.platform === "win32" }, async (t) => {
    const f = setup(t);
    const record = path.join(f.tmp, "probe.json");
    const executable = path.join(f.bin, "codex");
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
if (process.argv[2] !== ${JSON.stringify(stalledCommand)}) {
  console.log("codex probe ok");
  process.exit(0);
}
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 13000)'], { stdio: ["ignore", 1, 2] });
writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), parent: process.pid, child: child.pid }));
setTimeout(() => process.exit(0), 13000);
`);
    chmodSync(executable, 0o755);

    const started = performance.now();
    const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "codex" });
    const elapsed = performance.now() - started;

    assert.ok(elapsed < 12_000, `probe returned after ${Math.round(elapsed)} ms`);
    if (stalledCommand === "login") {
      assert.deepEqual(check(report, "auth"), {
        name: "auth",
        status: "unknown",
        detail: "codex: `codex login status` timed out after 10000 ms",
      });
    } else {
      assert.match(check(report, "runner").detail, /version unknown\)$/);
      assert.equal(check(report, "auth").status, "ok");
    }
    const observed: unknown = JSON.parse(readFileSync(record, "utf8"));
    assert.ok(typeof observed === "object" && observed !== null && "cwd" in observed && "parent" in observed && "child" in observed);
    assert.equal(typeof observed.cwd, "string");
    assert.equal(typeof observed.parent, "number");
    assert.equal(typeof observed.child, "number");
    assert.ok(typeof observed.cwd === "string" && !existsSync(observed.cwd), "probe directory was removed");
    for (const pid of [observed.parent, observed.child]) {
      assert.equal(typeof pid, "number");
      if (typeof pid !== "number") throw new Error("invalid stub PID");
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
        if (!state || state.startsWith("Z")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      assert.ok(!state || state.startsWith("Z"), `probe process ${pid} survived with state ${state}`);
    }
  });
}

for (const signal of ["SIGINT", "SIGTERM"] satisfies NodeJS.Signals[]) {
  test(`doctor cleans a stalled probe and its descendants on ${signal}`, { skip: process.platform === "win32" }, async (t) => {
    const f = setup(t);
    const record = path.join(f.tmp, "signal-probe.txt");
    const executable = path.join(f.bin, "codex");
    writeFileSync(executable, `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 13000)'], { stdio: ["ignore", 1, 2] });
writeFileSync(${JSON.stringify(record)}, [process.pid, child.pid, process.cwd()].join("\\n"));
if (${JSON.stringify(signal)} === "SIGINT") process.exit(0);
setTimeout(() => {}, 13000);
`);
    chmodSync(executable, 0o755);
    const cli = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", "doctor", "--repo", f.repo, "--runner", "codex", "--json"], {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = once(cli, "exit", { signal: AbortSignal.timeout(8_000) });
    const ownedGroups = [cli.pid];
    t.after(() => {
      for (const pid of ownedGroups) {
        if (pid === undefined) continue;
        try { process.kill(-pid, "SIGKILL"); }
        catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    });
    for (let attempt = 0; attempt < 500 && !existsSync(record); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const [parent, descendant, cwd] = readFileSync(record, "utf8").split("\n");
    const probePid = Number(parent);
    const descendantPid = Number(descendant);
    assert.ok(Number.isInteger(probePid) && probePid > 0);
    ownedGroups.push(probePid);
    assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
    assert.ok(cwd);
    assert.ok(cli.pid);
    if (signal === "SIGINT") {
      for (let attempt = 0; attempt < 100; attempt++) {
        const state = spawnSync("ps", ["-o", "stat=", "-p", String(probePid)], { encoding: "utf8" }).stdout.trim();
        if (!state || state.startsWith("Z")) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(probePid)], { encoding: "utf8" }).stdout.trim();
      assert.ok(!state || state.startsWith("Z"), "probe leader exited before the signal");
    }
    if (cli.exitCode === null && cli.signalCode === null) {
      try { process.kill(-cli.pid, signal); }
      catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
      }
    }
    const [code] = await exited;
    if (signal === "SIGINT") assert.ok(code === 130 || code === 0, `normal-exit probe cleanup exited ${String(code)}`);
    else assert.equal(code, 143);
    for (const pid of [probePid, descendantPid]) {
      const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
      assert.ok(!state || state.startsWith("Z"), `signal left process ${pid} running with state ${state}`);
    }
    assert.equal(existsSync(cwd), false, "signal cleanup removes the probe directory");
  });
}

for (const output of ["stdout", "split"]) {
  test(`doctor bounds ${output} probe output without echoing the runner payload`, async (t) => {
    const f = setup(t);
    const executable = path.join(f.bin, "codex");
    writeFileSync(executable, `#!/usr/bin/env node
if (process.argv[2] === "--version") { console.log("codex probe ok"); process.exit(0); }
process.stdout.write("x".repeat(${output === "split" ? 768 * 1024 : 1024 * 1024 + 1}));
${output === "split" ? 'process.stderr.write("y".repeat(768 * 1024));' : 'setTimeout(() => {}, 13000);'}
`);
    chmodSync(executable, 0o755);

    const report = await runDoctor({ repo: f.repo, version: "0.0.0-test", runner: "codex" });

    assert.equal(check(report, "auth").status, "unknown");
    assert.match(check(report, "auth").detail, / ENOBUFS$/);
    assert.doesNotMatch(JSON.stringify(report), /[xy]{160}/);
  });
}

test("doctor reports the canonical selected repository root from nested and linked folders", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");
  const nested = path.join(f.repo, "nested");
  mkdirSync(nested);
  const linked = path.join(f.tmp, "linked-repo");
  symlinkSync(f.repo, linked, "dir");
  for (const repo of [f.repo, nested, linked]) {
    const report = await runDoctor({ repo, version: "0.0.0-test" });
    assert.equal(report.repoRoot, realpathSync(f.repo));
    assert.equal(check(report, "git").status, "ok");
  }
  const notRepo = await runDoctor({ repo: f.tmp, version: "0.0.0-test" });
  assert.equal(notRepo.repoRoot, undefined);
  assert.equal(check(notRepo, "git").status, "fail");
});

for (const suffix of [" ", "\t", "\n"]) {
  test(`doctor preserves repository pathname suffix ${JSON.stringify(suffix)}`, async (t) => {
    const f = setup(t);
    codexStub(f.bin, 0, "Logged in using ChatGPT");
    const repo = path.join(f.tmp, `project${suffix}`);
    mkdirSync(repo);
    gitText(["init", "-q"], repo);
    const nested = path.join(repo, "nested");
    mkdirSync(nested);
    for (const selected of [repo, nested]) {
      const report = await runDoctor({ repo: selected, version: "0.0.0-test" });
      assert.equal(check(report, "git").status, "ok");
      assert.equal(report.repoRoot, realpathSync(repo));
    }
  });
}

test("doctor omits the selected root when Git is too old for safe attributes", async (t) => {
  const f = setup(t);
  codexStub(f.bin, 0, "Logged in using ChatGPT");
  stub(f.bin, "git", [
    'if [ "$1" = "--version" ]; then echo "git version 2.40.1"; exit 0; fi',
    'exec /usr/bin/git "$@"',
  ].join("\n"));

  const report = await runDoctor({ repo: f.repo, version: "0.0.0-test" });

  assert.equal(report.ok, false);
  assert.equal(report.repoRoot, undefined);
  assert.deepEqual(check(report, "git"), {
    name: "git",
    status: "fail",
    detail: "git version 2.40.1; needlefish needs git 2.41 or later",
    fix: "Upgrade git to 2.41 or later.",
  });
  assert.equal(check(report, "base").status, "ok");
});
