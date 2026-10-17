import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { writeWeeklyReport } from "./adoption-weekly";

function scenario(mode: "normal" | "warning" | "failure" | "empty", check: (dir: string, code: number, log: string) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "nf-adoption-weekly-"));
  try {
    const log = path.join(dir, "calls.jsonl");
    const gh = path.join(dir, "gh");
    const threads = [
      ["2026-10-08T23:59:59Z", "Before window"],
      ["2026-10-09T00:00:00Z", "Include start"],
      ["2026-10-15T23:59:59Z", "Include end minus one"],
      ["2026-10-16T00:00:00Z", "Exclude end"],
      ["2026-10-17T12:00:00Z", "Exclude future"],
    ].map(([createdAt, title]) => ({
      isOutdated: title === "Include start", isResolved: false, path: "src/a.ts",
      comments: { nodes: [{ author: { login: "github-actions" }, createdAt,
        body: mode === "warning" ? `**P2** ${title}` : `**P2 (validation): ${title}**` }] },
    }));
    const response = { data: { repository: { pullRequests: {
      pageInfo: { hasNextPage: false, endCursor: null }, nodes: mode === "empty" ? [] : [{
        number: 4, state: "MERGED", merged: true, updatedAt: "2026-10-17T12:00:00Z",
        reviews: { pageInfo: { hasPreviousPage: false, startCursor: null }, nodes: [] },
        reviewThreads: { pageInfo: { hasNextPage: mode === "warning" }, nodes: threads },
      }],
    } } } };
    writeFileSync(gh, `#!${process.execPath}\nconst fs = require('node:fs');\nconst args = process.argv.slice(2);\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\nif (${JSON.stringify(mode)} === 'failure') { process.stderr.write('HTTP 403: read access denied\\n'); process.exit(1); }\nprocess.stdout.write(${JSON.stringify(JSON.stringify(response))});\n`);
    chmodSync(gh, 0o755);
    const outputDir = path.join(dir, "report; touch INJECTED");
    const code = writeWeeklyReport({ outputDir, now: new Date("2026-10-16T23:22:00+09:00"),
      env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`, GITHUB_REPOSITORY: "frankekn/needlefish" } });
    check(outputDir, code, readFileSync(log, "utf8"));
    assert.equal(existsSync(path.join(dir, "INJECTED")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("weekly wrapper runs the real collector once and reports the exact completed UTC window", () => {
  scenario("normal", (dir, code, log) => {
    assert.equal(code, 0);
    const calls: unknown = JSON.parse(log.trim());
    assert.ok(Array.isArray(calls));
    assert.deepEqual(calls.slice(0, 2), ["api", "graphql"]);
    assert.ok(calls.includes("owner=frankekn"));
    assert.ok(calls.includes("name=needlefish"));
    const rows: unknown = JSON.parse(readFileSync(path.join(dir, "rows.json"), "utf8"));
    assert.deepEqual(rows, [
      { repo: "frankekn/needlefish", pr: 4, severity: "P2", category: "validation", fate: "addressed", resolved: false, path: "src/a.ts", created: "2026-10-09T00:00:00Z", author: "github-actions" },
      { repo: "frankekn/needlefish", pr: 4, severity: "P2", category: "validation", fate: "kept", resolved: false, path: "src/a.ts", created: "2026-10-15T23:59:59Z", author: "github-actions" },
    ]);
    const report = readFileSync(path.join(dir, "report.md"), "utf8");
    assert.match(report, /UTC window: \[2026-10-09T00:00:00.000Z, 2026-10-16T00:00:00.000Z\)/);
    assert.match(report, /\| all \| 50% \| 2 \| 1 \| 1 \| 0 \| 0 \|/);
    assert.match(report, /Collection status: collected. Unknown categories: 0/);
    assert.match(readFileSync(path.join(dir, "source-sha.txt"), "utf8"), /^[a-f0-9]{40}\n$/);
    assert.match(readFileSync(path.join(dir, "collector.json"), "utf8"), /2026-10-17T12:00:00Z/);
  });
});

test("truncation and unknown categories remain visible as partial data", () => {
  scenario("warning", (dir, code) => {
    assert.equal(code, 0);
    assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /Collection status: partial. Unknown categories: 2/);
    assert.match(readFileSync(path.join(dir, "stderr.txt"), "utf8"), /more than 100 review threads/);
    assert.match(readFileSync(path.join(dir, "metadata.json"), "utf8"), /only the first 100 are counted/);
  });
});

test("read-access failure exits nonzero and saves diagnostics without adoption totals", () => {
  scenario("failure", (dir, code) => {
    assert.equal(code, 1);
    const report = readFileSync(path.join(dir, "report.md"), "utf8");
    assert.match(report, /Collection status: failed/);
    assert.match(report, /No adoption totals are available/);
    assert.doesNotMatch(report, /\| all \|/);
    assert.match(readFileSync(path.join(dir, "stderr.txt"), "utf8"), /HTTP 403: read access denied/);
    assert.match(readFileSync(path.join(dir, "metadata.json"), "utf8"), /collector exited 1/);
  });
});

test("an empty successful collection is distinct from failure", () => {
  scenario("empty", (dir, code) => {
    assert.equal(code, 0);
    assert.equal(readFileSync(path.join(dir, "rows.json"), "utf8"), "[]\n");
    assert.match(readFileSync(path.join(dir, "report.md"), "utf8"), /0 finding threads, no finding threads/);
    assert.match(readFileSync(path.join(dir, "metadata.json"), "utf8"), /"status": "collected"/);
  });
});

test("other repositories are rejected before any collection or output", () => {
  assert.throws(() => writeWeeklyReport({ outputDir: "/unused", now: new Date(),
    env: { GITHUB_REPOSITORY: "someone/else; echo bad" } }), /restricted to frankekn\/needlefish/);
});

test("workflow has a single read-only collection path with pinned actions and failure artifacts", () => {
  const workflow: unknown = parse(readFileSync(new URL("../../.github/workflows/adoption-weekly.yml", import.meta.url), "utf8"));
  assert.ok(typeof workflow === "object" && workflow !== null && "permissions" in workflow && "on" in workflow && "jobs" in workflow);
  assert.deepEqual(workflow.permissions, { contents: "read", "pull-requests": "read" });
  assert.deepEqual(workflow.on, { workflow_dispatch: null, schedule: [{ cron: "17 6 * * 1" }] });
  const raw = JSON.stringify(workflow.jobs);
  assert.match(raw, /pnpm exec tsx eval\/tools\/adoption-weekly.ts adoption-weekly/);
  assert.match(raw, /"GH_TOKEN":"\$\{\{ github.token \}\}"/);
  assert.match(raw, /"if":"always\(\)"/);
  const yaml = readFileSync(new URL("../../.github/workflows/adoption-weekly.yml", import.meta.url), "utf8");
  const actions = [...yaml.matchAll(/uses: (.+)/g)].map((match) => match[1].split(" #")[0]);
  assert.equal(actions.length, 3);
  for (const action of actions) assert.match(action, /^actions\/(checkout|setup-node|upload-artifact)@[a-f0-9]{40}$/);
  assert.doesNotMatch(yaml, /secrets\.|pull_request_target|issues: write|pull-requests: write/);
});
