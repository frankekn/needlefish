import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

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
  t.after(() => rmSync(dir, { recursive: true, force: true }));
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
if (args[0] === 'verdict' || args[0] === 'render') {
  const r = cp.spawnSync(${JSON.stringify(process.execPath)}, ['--import', ${JSON.stringify(tsx)}, ${JSON.stringify(cli)}, ...args], { encoding: 'utf8' });
  process.stdout.write(r.stdout); process.stderr.write(r.stderr); process.exit(r.status ?? 1);
}
if (process.env.FAKE_WAIT === '1') {
  const child = cp.spawn(${JSON.stringify(process.execPath)}, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  fs.writeFileSync(${JSON.stringify(join(dir, "child.pid"))}, String(child.pid));
  setInterval(() => {}, 1000);
} else {
  process.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));
  process.exit(Number(process.env.FAKE_STATUS ?? '0'));
}
`);
  chmodSync(fake, 0o755);
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, NEEDLEFISH_SHIFT_LEFT_TIMEOUT_MS: "15000" };
  const base = { schemaVersion: 1, verdict: "pass", summary: "Completed review.", findings: [], checked: ["file.ts caller"], residualRisks: [], baseSha: head, headSha: head };
  function run(raw, status = 0, extra = {}) {
    writeFileSync(fixture, typeof raw === "string" ? raw : JSON.stringify(raw));
    return spawnSync(process.execPath, [join(repo, ".needlefish/shift-left/review-gate.mjs"), "HEAD"], {
      cwd: repo, env: { ...env, FAKE_STATUS: String(status), ...extra }, encoding: "utf8", timeout: 20000,
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
  for (const [ref, sha, expected] of [
    ["refs/heads/topic", f.head, 0], ["refs/heads/topic", "0".repeat(40), 1],
    ["refs/tags/topic", f.head, 1],
  ]) {
    const r = spawnSync("sh", [hook, "origin", "unused"], {
      cwd: f.repo, env: f.env, input: `${ref} ${sha} refs/heads/topic ${"0".repeat(40)}\n`, encoding: "utf8", timeout: 20000,
    });
    assert.equal(r.status, expected, r.stderr);
    if (expected === 0) assert.match(r.stdout, /LGTM/);
    else assert.equal(r.stdout, "");
  }
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
