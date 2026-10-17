import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const source = resolve("docs/shift-left");
const cli = resolve("src/cli.ts");
const tsx = resolve("node_modules/tsx/dist/loader.mjs");
const finding = {
  severity: "P2", title: "Confirmed defect", category: "bug", file: "file.ts",
  lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: "A caller fails.",
  suggestedFix: "Repair the caller.", validation: "Check the caller.",
};

function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), "needlefish-shift-left-test-"));
  t.after(() => {
    const pidFile = join(dir, "review.pid");
    if (existsSync(pidFile)) {
      try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = join(dir, "repo");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  mkdirSync(repo);
  mkdirSync(bin);
  mkdirSync(home);
  const git = (...args) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
  git("init", "-q");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "base");
  const head = git("rev-parse", "HEAD");
  cpSync(source, join(repo, ".needlefish/shift-left"), { recursive: true });
  const cache = join(home, ".cache/needlefish/repo");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, "last-review.json"), 'STALE CACHE MUST NOT BE READ');
  const log = join(dir, "calls.jsonl");
  const fixture = join(dir, "result.json");
  const fake = join(bin, "needlefish");
  writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
const command = args[0] === 'verdict' || args[0] === 'render' ? args[0] : 'review';
if (process.env.FAKE_DIAGNOSTIC_COMMAND === command) process.stderr.write(process.env.FAKE_STDERR ?? '');
if (process.env.FAKE_FAIL_COMMAND === command) {
  process.stdout.write('PRIVATE_CONSUMER_STDOUT');
  process.exitCode = 2;
} else if (args[0] === 'verdict' || args[0] === 'render') {
  const r = cp.spawnSync(${JSON.stringify(process.execPath)}, ['--import', ${JSON.stringify(tsx)}, ${JSON.stringify(cli)}, ...args], { encoding: 'utf8', maxBuffer: 8_000_000 });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exitCode = r.status ?? 1;
} else if (process.env.FAKE_WAIT === '1') {
  fs.writeFileSync(${JSON.stringify(join(dir, "review.pid"))}, String(process.pid));
  const child = cp.spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(join(dir, "child.pid"))}, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
  process.exitCode = Number(process.env.FAKE_STATUS ?? '0');
}
`);
  chmodSync(fake, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: "15000" };
  const base = { schemaVersion: 1, verdict: "pass", summary: "Completed review.", findings: [], checked: ["file.ts caller"], residualRisks: [], baseSha: head, headSha: head };
  function run(raw, status = 0, extra = {}) {
    writeFileSync(fixture, typeof raw === "string" ? raw : JSON.stringify(raw));
    return spawnSync(process.execPath, [join(repo, ".needlefish/shift-left/review-gate.mjs"), "HEAD"], {
      cwd: repo, env: { ...env, FAKE_STATUS: String(status), ...extra }, encoding: "utf8", timeout: 20000, maxBuffer: 8_000_000,
    });
  }
  return { dir, repo, head, log, base, env, fixture, run, git };
}

for (const [verdict, status, findings, residualRisks, expectedText] of [
  ["pass", 0, [], [], "LGTM"],
  ["changes_requested", 1, [finding], [], "Confirmed defect"],
  ["needs_human", 1, [], [{ text: "Missing evidence", blocks: true }], "Missing evidence"],
]) {
  test(`shared gate confirms literal ${verdict}`, (t) => {
    const f = setup(t);
    const result = f.run({ ...f.base, verdict, findings, residualRisks }, status);
    assert.equal(result.status, status, result.stderr);
    assert.match(result.stdout, new RegExp(expectedText));
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls[0], ["--repo", realpathSync(f.repo), "--branch", "--base", "HEAD", "--json"]);
    assert.equal(calls.length, 3);
    assert.equal(calls[1][0], "verdict");
    assert.equal(calls[2][0], "render");
    assert.equal(existsSync(calls[1][1]), false);
    assert.equal(readFileSync(join(f.env.HOME, ".cache/needlefish/repo/last-review.json"), "utf8"), "STALE CACHE MUST NOT BE READ");
  });
}

for (const [name, raw, status] of [
  ["bad JSON", "not json", 0], ["no output", "", 0],
  ["incomplete pass", '{"verdict":"pass"}', 0],
  ["bad findings shape", { findings: [{}] }, 0],
  ["forged pass with blocking finding", { findings: [finding] }, 0],
  ["nonzero pass", {}, 1], ["operational failure", {}, 2],
  ["zero non-pass", { verdict: "needs_human", residualRisks: [{ text: "unknown", blocks: true }] }, 0],
  ["wrong head", { headSha: "another-head" }, 0],
]) {
  test(`shared gate blocks ${name}`, (t) => {
    const f = setup(t);
    const result = f.run(typeof raw === "string" ? raw : { ...f.base, ...raw }, status);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Needlefish gate blocked/);
  });
}

test("docs-only policy skip remains visible and P3 does not force a repair", (t) => {
  const f = setup(t);
  const skip = f.run({ ...f.base, docsOnlyFastPath: true, summary: "Documentation change." });
  assert.equal(skip.status, 0, skip.stderr);
  assert.match(skip.stdout, /skip|Skipped|docs-only/i);
  const p3 = f.run({ ...f.base, findings: [{ ...finding, severity: "P3" }] });
  assert.equal(p3.status, 0, p3.stderr);
  assert.match(p3.stdout, /P3/);
});

test("deadline fails closed and removes the owned subprocess group", (t) => {
  const f = setup(t);
  const result = f.run(f.base, 0, { FAKE_WAIT: "1", NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: "500" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /deadline expired/);
  const pid = Number(readFileSync(join(f.dir, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
});

test("pre-push checks HEAD and blocks unsupported pushed refs", (t) => {
  const f = setup(t);
  writeFileSync(f.fixture, JSON.stringify(f.base));
  const hook = join(f.repo, ".needlefish/shift-left/pre-push");
  const text = readFileSync(hook, "utf8").replace("review-gate.mjs origin/main", "review-gate.mjs HEAD");
  writeFileSync(hook, text);
  for (const [ref, sha, remoteRef, expected] of [
    ["refs/heads/topic", f.head, "refs/heads/topic", 0],
    ["HEAD", f.head, "refs/heads/topic", 0],
    ["HEAD", "0".repeat(40), "refs/heads/topic", 1],
    ["HEAD", f.head, "refs/tags/topic", 1],
    ["refs/heads/topic", "0".repeat(40), "refs/heads/topic", 1],
    ["refs/tags/topic", f.head, "refs/heads/topic", 1],
    ["refs/heads/topic", f.head, "refs/tags/topic", 1],
    ["(delete)", "0".repeat(40), "refs/heads/topic", 1],
  ]) {
    rmSync(f.log, { force: true });
    const r = spawnSync("sh", [hook, "origin", "unused"], {
      cwd: f.repo, env: f.env, input: `${ref} ${sha} ${remoteRef} ${"0".repeat(40)}\n`, encoding: "utf8", timeout: 20000,
    });
    assert.equal(r.status, expected, r.stderr);
    if (expected === 0) {
      assert.match(r.stdout, /LGTM/);
      assert.equal(readFileSync(f.log, "utf8").trim().split("\n").length, 3);
    } else {
      assert.equal(r.stdout, "");
      assert.equal(existsSync(f.log), false);
    }
  }
});


test("detached HEAD branch push runs the installed gate", (t) => {
  const f = setup(t);
  writeFileSync(f.fixture, JSON.stringify(f.base));
  f.git("checkout", "--detach", "-q", f.head);
  const remote = join(f.dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  f.git("remote", "add", "origin", remote);
  f.git("config", "core.hooksPath", ".needlefish/shift-left");
  const hook = join(f.repo, ".needlefish/shift-left/pre-push");
  writeFileSync(hook, readFileSync(hook, "utf8").replace("review-gate.mjs origin/main", "review-gate.mjs HEAD"));
  chmodSync(hook, 0o755);
  const result = spawnSync("git", ["push", "origin", "HEAD:refs/heads/topic"], {
    cwd: f.repo, env: f.env, encoding: "utf8", timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LGTM/);
  assert.equal(execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/topic"], { encoding: "utf8" }).trim(), f.head);
  assert.deepEqual(readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse)[0],
    ["--repo", realpathSync(f.repo), "--branch", "--base", "HEAD", "--json"]);
});

test("documented review syntax reaches the real CLI dry-run without a model", (t) => {
  const f = setup(t);
  writeFileSync(join(f.repo, "file.ts"), "export const count = 1;\n");
  f.git("add", "file.ts");
  f.git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "change");
  const result = spawnSync(process.execPath, ["--import", tsx, cli, "--repo", f.repo, "--branch", "--base", f.head, "--json", "--dry-run"], {
    env: f.env, encoding: "utf8", timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file.ts/);
  assert.equal(existsSync(f.log), false);
});


test("hook-bound head prevents a concurrent checkout from reviewing another commit", (t) => {
  const f = setup(t);
  const result = f.run(f.base, 0, { NEEDLEFISH_SHIFT_LEFT_EXPECTED_HEAD: "another-commit" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /differs from the pushed commit/);
  assert.equal(existsSync(f.log), false);
});


test("SIGHUP stops the detached review group and removes its temporary result", { timeout: 10000 }, async (t) => {
  const f = setup(t);
  writeFileSync(f.fixture, JSON.stringify(f.base));
  const gate = spawn(process.execPath, [join(f.repo, ".needlefish/shift-left/review-gate.mjs"), "HEAD"], {
    cwd: f.repo, env: { ...f.env, FAKE_WAIT: "1", TMPDIR: f.dir }, detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => {
    try { process.kill(-gate.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const closed = new Promise((resolve) => gate.on("close", (code, signal) => resolve({ code, signal })));
  const pidFile = join(f.dir, "child.pid");
  for (let attempts = 0; !existsSync(pidFile) && attempts < 300; attempts++) await delay(10);
  assert.equal(existsSync(pidFile), true);
  gate.kill("SIGHUP");
  assert.deepEqual(await closed, { code: 1, signal: null });
  const pid = Number(readFileSync(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith("needlefish-pre-pr-")), []);
});


test("real Git rejects non-branch endpoints before review and reviews valid pushes once", (t) => {
  const f = setup(t);
  writeFileSync(f.fixture, JSON.stringify(f.base));
  const bare = join(f.dir, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", bare]);
  f.git("remote", "add", "origin", bare);
  f.git("update-ref", "refs/remotes/origin/main", f.head);
  f.git("tag", "source-tag");
  f.git("push", "origin", "HEAD:refs/heads/delete-me");
  const hook = join(f.repo, ".git/hooks/pre-push");
  cpSync(join(f.repo, ".needlefish/shift-left/pre-push"), hook);
  chmodSync(hook, 0o755);
  const branch = f.git("symbolic-ref", "HEAD");
  for (const refspec of [`${branch}:refs/tags/v1`, "refs/tags/source-tag:refs/heads/from-tag", ":refs/heads/delete-me"]) {
    const r = spawnSync("git", ["push", "origin", refspec], { cwd: f.repo, env: f.env, encoding: "utf8", timeout: 20000 });
    t.diagnostic(JSON.stringify({ refspec, exit: r.status, stdout: r.stdout, stderr: r.stderr }));
    assert.equal(r.status, 1, `${refspec}\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /Needlefish gate blocked: push a branch ref/);
    assert.equal(existsSync(f.log), false);
    assert.equal(execFileSync("git", ["--git-dir", bare, "for-each-ref", "--format=%(refname) %(objectname)"], { encoding: "utf8" }).trim(), `refs/heads/delete-me ${f.head}`);
  }
  for (const destinations of [["one"], ["two", "three"]]) {
    const r = spawnSync("git", ["push", "origin", ...destinations.map((name) => `${branch}:refs/heads/${name}`)], { cwd: f.repo, env: f.env, encoding: "utf8", timeout: 20000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /LGTM/);
    const calls = readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(calls.map((args) => args[0]), destinations.length === 1 ? ["--repo", "verdict", "render"] : ["--repo", "verdict", "render", "--repo", "verdict", "render"]);
    for (const name of destinations) assert.equal(execFileSync("git", ["--git-dir", bare, "rev-parse", `refs/heads/${name}`], { encoding: "utf8" }).trim(), f.head);
  }
});


for (const [name, raw, status, command, extra] of [
  ["operational empty review", "", 2, "review", {}],
  ["empty review", "", 0, "review", {}],
  ["malformed review", "PRIVATE_RAW_MODEL_STDOUT", 0, "review", {}],
  ["review exit mismatch", null, 2, "review", {}],
  ["verdict failure", null, 0, "verdict", { FAKE_FAIL_COMMAND: "verdict" }],
  ["render failure", null, 0, "render", { FAKE_FAIL_COMMAND: "render" }],
  ["review timeout", null, 0, "review", { FAKE_WAIT: "1", NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: "500" }],
]) {
  test(`blocked ${name} preserves only CLI diagnostics`, (t) => {
    const f = setup(t);
    const result = f.run(raw ?? { ...f.base, summary: "PRIVATE_MODEL_JSON" }, status, {
      FAKE_DIAGNOSTIC_COMMAND: command, FAKE_STDERR: `${command} diagnostic\n`,
      PRIVATE_ENV_SENTINEL: "PRIVATE_ENV_SECRET", ...extra,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(`^${command} diagnostic\\nNeedlefish gate blocked:`));
    assert.doesNotMatch(result.stderr, /PRIVATE_RAW_MODEL_STDOUT|PRIVATE_CONSUMER_STDOUT|PRIVATE_MODEL_JSON|PRIVATE_ENV_SECRET/);
    assert.equal(result.stderr.match(/diagnostic/g)?.length, 1);
  });
}

test("successful gate emits CLI diagnostics once", (t) => {
  const f = setup(t);
  const result = f.run(f.base, 0, { FAKE_DIAGNOSTIC_COMMAND: "review", FAKE_STDERR: "review diagnostic\n" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /LGTM/);
  assert.equal(result.stderr, "review diagnostic\n");
});

test("blocked diagnostics stay bounded and separate from the gate error", (t) => {
  const f = setup(t);
  const result = f.run("", 2, { FAKE_DIAGNOSTIC_COMMAND: "review", FAKE_STDERR: "x".repeat(20000) });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.indexOf("\nNeedlefish gate blocked:"), 16384);
  assert.equal(result.stderr.slice(0, 16384) === "x".repeat(16384), true);
  assert.equal(result.stderr.includes("x".repeat(16385)), false);
});


test("real verdict validation diagnostics survive a schema failure", (t) => {
  const f = setup(t);
  const result = f.run({ ...f.base, findings: [{}], summary: "PRIVATE_MODEL_JSON" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^needlefish: invalid cached review /);
  assert.match(result.stderr, /\nNeedlefish gate blocked: review schema or derived verdict validation failed\n$/);
  assert.doesNotMatch(result.stderr, /PRIVATE_MODEL_JSON/);
});


for (const args of [[], ["HEAD", "extra"]]) {
  test(`gate reports usage for invalid positional arguments ${JSON.stringify(args)}`, (t) => {
    const f = setup(t);
    const result = spawnSync(process.execPath, [join(f.repo, ".needlefish/shift-left/review-gate.mjs"), ...args], {
      cwd: f.repo, env: { ...f.env, NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: "PRIVATE_INVALID_TIMEOUT" }, encoding: "utf8", timeout: 20000,
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Usage: node .needlefish/shift-left/review-gate.mjs <base-ref>\n");
    assert.equal(existsSync(f.log), false);
  });
}

for (const timeout of ["0", "-1", "NaN", "Infinity", "1.5", "2147483648", "4294967296", "9007199254740992", "PRIVATE_INVALID_TIMEOUT"]) {
  test(`gate rejects unschedulable timeout ${timeout} before the producer`, (t) => {
    const f = setup(t);
    const result = f.run(f.base, 0, { NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: timeout });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "Needlefish gate blocked: NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS must be an integer between 1 and 2147483647 milliseconds\n");
    assert.equal(existsSync(f.log), false);
  });
}

for (const timeout of ["15000", "2147483647"]) {
  test(`gate accepts schedulable timeout ${timeout} without clamping`, (t) => {
    const f = setup(t);
    const result = f.run(f.base, 0, { NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: timeout });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /LGTM/);
    assert.equal(result.stderr, "");
    assert.equal(readFileSync(f.log, "utf8").trim().split("\n").length, 3);
  });
}

test("minimum one-millisecond budget expires without a timer overflow", (t) => {
  const f = setup(t);
  const result = f.run(f.base, 0, { FAKE_WAIT: "1", NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: "1" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "Needlefish gate blocked: review deadline expired\n");
});

for (const [name, checked] of [
  ["cumulative review and render", "c".repeat(4_100_000)],
  ["UTF-8 bytes rather than characters", "界".repeat(1_400_000)],
]) {
  test(`whole-gate output cap blocks ${name} with real consumers`, (t) => {
    const f = setup(t);
    const result = f.run({ ...f.base, checked: [checked] }, 0, {
      FAKE_DIAGNOSTIC_COMMAND: "review", FAKE_STDERR: "review diagnostic\n",
    });
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "review diagnostic\nNeedlefish gate blocked: review output exceeds 8 MB\n");
    assert.deepEqual(readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse).map((args) => args[0]), ["--repo", "verdict", "render"]);
  });
}

test("whole-gate output cap includes stderr and permits the nearby lower total", (t) => {
  const f = setup(t);
  const raw = { ...f.base, checked: ["c".repeat(3_999_700)] };
  const passed = f.run(raw);
  assert.equal(passed.error, undefined);
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /LGTM/);
  assert.equal(passed.stderr, "");
  const totalBytes = Buffer.byteLength(JSON.stringify(raw)) + Buffer.byteLength(passed.stdout) + Buffer.byteLength("stored:  pass\nderived: pass\n");
  assert.ok(totalBytes <= 8_000_000);
  assert.ok(totalBytes + 1000 > 8_000_000);
  const blocked = f.run(raw, 0, { FAKE_DIAGNOSTIC_COMMAND: "review", FAKE_STDERR: "d".repeat(1000) });
  assert.equal(blocked.error, undefined);
  assert.equal(blocked.status, 1);
  assert.equal(blocked.stdout, "");
  assert.equal(blocked.stderr, "d".repeat(1000) + "\nNeedlefish gate blocked: review output exceeds 8 MB\n");
});
