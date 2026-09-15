import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
type Scenario = "pass" | "needs_human" | "P0" | "P1" | "P2" | "P3" |
  "deep_failure" | "malformed" | "timeout" | "unavailable" | "docs";
type PrState = "open" | "stale" | "closed_after" | "closed";

function record(value: unknown): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function fixture(t: TestContext, scenario: Scenario, prState: PrState = "open", previous = false) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-status-test-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  const bin = path.join(tmp, "bin");
  const home = path.join(tmp, "home");
  for (const dir of [repo, bin, home, path.join(repo, "src")]) mkdirSync(dir, { recursive: true });
  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args: string[]) => {
    const res = spawnSync("git", args, { cwd: repo, env: gitEnv, encoding: "utf8" });
    assert.equal(res.status, 0, `${args.join(" ")}: ${res.stderr}`);
    return res.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.name", "Needlefish Test");
  git("config", "user.email", "test@example.invalid");
  git("branch", "-M", "main");
  for (const file of ["src/a.ts", "src/b.ts"]) writeFileSync(path.join(repo, file), "export const value = 1;\n");
  writeFileSync(path.join(repo, "README.md"), "Before\n");
  git("add", "."); git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-qb", "feature");
  const changed = scenario === "docs" ? ["README.md"] : ["src/a.ts", "src/b.ts"];
  for (const file of changed) writeFileSync(path.join(repo, file), file.endsWith(".md") ? "After\n" : "export const value = 2;\n");
  git("add", "."); git("commit", "-qm", "feature");
  const head = git("rev-parse", "HEAD");
  const posts = path.join(tmp, "posts.jsonl");
  const calls = path.join(tmp, "calls.log");
  const reads = path.join(tmp, "reads.txt");
  writeFileSync(reads, "0");
  const findings = scenario.startsWith("P") ? [{ severity: scenario, category: "bug", title: "Wrong value", file: "src/a.ts",
    lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: "Returns the wrong value", suggestedFix: "Restore the value", validation: "Inspect the return" }] : [];
  const raw = { summary: "Review fixture.", findings, checked: ["Checked the changed files"],
    residual_risks: scenario === "needs_human" ? [{ text: "src/b.ts needs human verification", blocks: true }] : [],
    hotspots: [
      { name: "available", files: ["src/a.ts"], why: "Changed", risk: "high", edges: [] },
      { name: "unavailable", files: ["src/b.ts"], why: "Changed", risk: "high", edges: [] },
    ] };
  const runner = path.join(bin, "claude");
  writeFileSync(runner, `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
fs.appendFileSync(${JSON.stringify(calls)}, ".");
const scenario = ${JSON.stringify(scenario)};
if (scenario === "timeout") {
  setInterval(() => {}, 1000);
} else if (scenario === "malformed" || (scenario === "deep_failure" && prompt.includes('"name": "unavailable"'))) {
  process.stdout.write("not JSON");
} else {
  process.stdout.write(${JSON.stringify(JSON.stringify(raw))});
}
`, { mode: 0o755 });
  const pr = { number: 7, title: "Fixture", body: "Review this change", state: "open", head: { sha: head }, base: { sha: base },
    baseRefOid: base, headRefOid: head, baseRefName: "main", headRefName: "feature", comments: [], reviews: [], statusCheckRollup: [] };
  const previousReview = { id: 23, user: { login: "tester", type: "User" },
    body: `<!-- needlefish-state: ${JSON.stringify({ v: 1, headSha: base, findings: [] })} -->` };
  writeFileSync(path.join(bin, "gh"), `#!${process.execPath}\n` + String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const pr = ${JSON.stringify(pr)};
const state = ${JSON.stringify(prState)};
const send = value => process.stdout.write(JSON.stringify(value));
if (args[0] === "pr" && args[1] === "view") {
  send(pr);
} else if (args[0] === "api") {
  const endpoint = args.find(a => a === "user" || a.startsWith("repos/"));
  const index = args.indexOf("-X");
  const method = index < 0 ? "GET" : args[index + 1];
  if (method !== "GET") {
    const payload = args.includes("--input") ? JSON.parse(fs.readFileSync(0, "utf8")) : {};
    fs.appendFileSync(${JSON.stringify(posts)}, JSON.stringify({ endpoint, method, payload }) + "\n");
    send({ id: endpoint.endsWith("/check-runs") ? 42 : 23 });
  } else if (endpoint === "user") {
    send({ login: "tester" });
  } else if (endpoint === "repos/example/project/pulls/7") {
    const n = Number(fs.readFileSync(${JSON.stringify(reads)}, "utf8"));
    fs.writeFileSync(${JSON.stringify(reads)}, String(n + 1));
    if (state === "closed" || (state === "closed_after" && n > 0)) pr.state = "closed";
    if (state === "stale" && n > 0) pr.head.sha = "f".repeat(40);
    send(pr);
  } else if (endpoint === "repos/example/project/pulls/7/reviews") {
    send(${JSON.stringify(previous ? [previousReview] : [])});
  } else if (endpoint === "repos/example/project/issues/7/comments") {
    send([]);
  } else if (endpoint && endpoint.startsWith("repos/example/project/labels/")) {
    send({ name: "existing" });
  } else {
    throw new Error("Unexpected test gh call: " + args.join(" "));
  }
} else {
  throw new Error("Unexpected test gh command: " + args.join(" "));
}
`, { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, HOME: home, USERPROFILE: home,
    TMPDIR: tmp, LANG: "C.UTF-8", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
    GITHUB_REPOSITORY: "example/project", PR_BASE_SHA: base, PR_HEAD_SHA: head,
    CLAUDE_BIN: scenario === "unavailable" ? path.join(bin, "missing-runner") : runner,
    NEEDLEFISH_NO_RETRY: "1", NEEDLEFISH_NO_FAST_PATH: "0",
    NEEDLEFISH_LARGE_FILE_COUNT: scenario === "deep_failure" ? "1" : "10",
    NEEDLEFISH_TIMEOUT_MS: scenario === "timeout" ? "200" : "5000",
    NEEDLEFISH_REVIEW_TIMEOUT_MS: "20000", NEEDLEFISH_GH_POST_RETRY_MS: "0",
  };
  return {
    run(mode: "local" | "pr" | "github", json = false) {
      const args = mode === "github" ? ["--github", "--pr", "7"] : mode === "pr" ? ["pr", "7"] : ["--branch", "--base", base];
      return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args, "--repo", repo, "--runner", "claude", ...(json ? ["--json"] : [])], {
        cwd: root, env, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      });
    },
    posts() {
      return existsSync(posts) ? readFileSync(posts, "utf8").trim().split("\n").filter(Boolean).map(line => record(JSON.parse(line))) : [];
    },
    calls() { return existsSync(calls) ? readFileSync(calls, "utf8").length : 0; },
  };
}

for (const mode of ["local", "pr"] as const) {
  for (const json of [false, true]) {
    for (const scenario of ["pass", "needs_human", "P2", "P3"] as const) {
      test(`${mode} ${json ? "JSON" : "Markdown"} exits according to ${scenario}`, t => {
        const f = fixture(t, scenario);
        const res = f.run(mode, json);
        assert.equal(res.error, undefined);
        const blocked = scenario === "needs_human" || scenario === "P2";
        assert.equal(res.status, blocked ? 1 : 0, res.stderr);
        const verdict = scenario === "P2" ? "changes_requested" : scenario === "needs_human" ? "needs_human" : "pass";
        if (json) assert.equal(record(JSON.parse(res.stdout)).verdict, verdict);
        else assert.match(res.stdout, verdict === "pass" ? /^LGTM/ : verdict === "needs_human" ? /^NEEDS HUMAN/ : /^CHANGES REQUESTED/);
        assert.ok(f.calls() >= 2, "run the real review and critic pipeline with the fake runner");
      });
    }
  }
}

for (const scenario of ["pass", "needs_human", "P0", "P1", "P2", "P3", "deep_failure"] as const) {
  test(`GitHub ${scenario} completes the owned check with the matching exit status`, t => {
    const f = fixture(t, scenario);
    const res = f.run("github");
    const blocked = scenario !== "pass" && scenario !== "P3";
    assert.equal(res.error, undefined);
    assert.equal(res.status, blocked ? 1 : 0, res.stderr);
    const posts = f.posts();
    const completed = posts.filter(p => p.endpoint === "repos/example/project/check-runs/42" && p.method === "PATCH");
    assert.equal(completed.length, 1);
    const payload = record(completed[0].payload);
    assert.equal(payload.status, "completed");
    assert.equal(payload.conclusion, blocked ? "failure" : "success");
    const reviews = posts.filter(p => p.endpoint === "repos/example/project/pulls/7/reviews" && p.method === "POST");
    assert.equal(reviews.length, 1);
    assert.equal(record(reviews[0].payload).event, "COMMENT");
    if (scenario === "needs_human" || scenario === "deep_failure") {
      const output = record(payload.output);
      assert.match(String(output.title), /needs_human.*review incomplete/);
      assert.match(String(output.summary), /Retry the review/);
      assert.match(String(record(reviews[0].payload).body), /not a pass or a confirmed code defect/);
      assert.doesNotMatch(String(output.title), /changes_requested|review failed/);
    }
    if (scenario === "deep_failure") {
      assert.match(res.stdout, /1\/2 changed files deep-reviewed/);
      assert.match(res.stdout, /DEEP PASS FAILED|not deep-reviewed/);
    }
  });
}

test("GitHub re-review with needs_human updates the existing review and fails its check", t => {
  const f = fixture(t, "needs_human", "open", true);
  const res = f.run("github");
  assert.equal(res.status, 1, res.stderr);
  const posts = f.posts();
  assert.ok(posts.some(p => p.endpoint === "repos/example/project/pulls/7/reviews/23" && p.method === "PUT"));
  const check = posts.find(p => p.endpoint === "repos/example/project/check-runs/42");
  assert.ok(check);
  assert.equal(record(check.payload).conclusion, "failure");
});

for (const scenario of ["malformed", "timeout", "unavailable"] as const) {
  for (const mode of ["local", "github"] as const) {
    test(`${mode} ${scenario} is an operational failure, never a pass`, t => {
      const f = fixture(t, scenario);
      const res = f.run(mode);
      assert.equal(res.error, undefined);
      assert.equal(res.status, 1, res.stderr);
      assert.doesNotMatch(res.stdout, /^LGTM/);
      if (mode === "github") {
        const check = f.posts().find(p => p.endpoint === "repos/example/project/check-runs/42");
        assert.ok(check);
        const payload = record(check.payload);
        assert.equal(payload.conclusion, "failure");
        assert.equal(record(payload.output).title, "Needlefish: review failed");
      }
    });
  }
}

for (const state of ["stale", "closed_after"] as const) {
  test(`GitHub ${state} remains superseded instead of posting an incomplete verdict`, t => {
    const f = fixture(t, "needs_human", state);
    const res = f.run("github");
    assert.equal(res.status, 0, res.stderr);
    const posts = f.posts();
    const check = posts.find(p => p.endpoint === "repos/example/project/check-runs/42");
    assert.ok(check);
    const payload = record(check.payload);
    assert.equal(payload.conclusion, "neutral");
    assert.equal(record(payload.output).title, "Needlefish: superseded");
    assert.ok(!posts.some(p => String(p.endpoint).includes("/reviews") || String(p.endpoint).includes("/comments")));
  });
}

test("GitHub already closed PR still skips without model calls or writes", t => {
  const f = fixture(t, "needs_human", "closed");
  const res = f.run("github");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(f.calls(), 0);
  assert.deepEqual(f.posts(), []);
  assert.match(res.stdout, /closed_pr/);
});

for (const mode of ["local", "github"] as const) {
  test(`${mode} docs-only policy bypass succeeds without pretending a model ran`, t => {
    const f = fixture(t, "docs");
    const res = f.run(mode);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(f.calls(), 0);
    assert.match(res.stdout, /model review skipped/);
  });
}
