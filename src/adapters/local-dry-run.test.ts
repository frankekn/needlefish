import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { commitAll, gitText, headSha, initRepo } from "../shared/codex-runner-test-fixtures";

type DryRunFixture = {
  readonly tmp: string;
  readonly repo: string;
  readonly home: string;
  readonly marker: string;
  readonly fakeBin: string;
};

function isJsonObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(raw: string): { readonly [key: string]: unknown } {
  const value: unknown = JSON.parse(raw);
  if (!isJsonObject(value)) {
    throw new Error("expected JSON object");
  }
  return value;
}

// A temp repo plus a stub `claude` runner that records its invocation in
// `marker` — a dry run must leave that marker absent — and a fake HOME so the
// cache write would land inside the fixture.
function setupDryRunFixture(
  t: TestContext,
  files: readonly { path: string; content: string }[]
): DryRunFixture {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-dry-run-test-"));
  const repo = initRepo(tmp);
  const home = path.join(tmp, "home");
  const fakeBin = path.join(tmp, "bin");
  const marker = path.join(tmp, "runner-was-called");
  t.after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  gitText(["branch", "-M", "main"], repo);
  gitText(["checkout", "-b", "feature"], repo);
  for (const file of files) {
    const target = path.join(repo, file.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, file.content);
  }
  commitAll(repo, "feature");

  mkdirSync(fakeBin);
  const claude = path.join(fakeBin, "claude");
  writeFileSync(
    claude,
    [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(marker)}, 'called');`,
      "process.stdout.write(JSON.stringify({ summary: 'ok', findings: [], checked: ['checked'], residual_risks: [] }));",
    ].join("\n")
  );
  chmodSync(claude, 0o755);
  return { tmp, repo, home, marker, fakeBin };
}

function runCli(fixture: DryRunFixture, args: readonly string[]) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
    HOME: fixture.home,
    CLAUDE_BIN: "claude",
    NEEDLEFISH_RUNNER: "claude",
  };
  delete env.NEEDLEFISH_NO_FAST_PATH;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), ...args],
    { cwd: process.cwd(), encoding: "utf8", env }
  );
}

function cacheFile(fixture: DryRunFixture): string {
  return path.join(fixture.home, ".cache", "needlefish", "repo", "last-review.json");
}

test("--dry-run on a docs-only diff reports the fast path and never runs the runner", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "docs/guide.md", content: "guide\n" },
  ]);

  const result = runCli(fixture, ["--repo", fixture.repo, "--dry-run", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "runner must not be invoked");
  assert.equal(existsSync(cacheFile(fixture)), false, "no last-review.json may be written");
  const summary = parseJsonObject(result.stdout);
  assert.equal(summary.mode, "branch");
  assert.equal(summary.docsOnlyFastPath, true);
  assert.equal(summary.largePath, false);
  assert.deepEqual(summary.changedFiles, [{ path: "docs/guide.md", surface: "docs" }]);
  assert.deepEqual(summary.prMeta, { present: false });
  const agentsMd = summary.agentsMd;
  assert.ok(isJsonObject(agentsMd));
  assert.equal(agentsMd.present, false);
  assert.equal(typeof summary.patchBytes, "number");
  assert.equal(typeof summary.patchStat, "string");
});

test("--dry-run on a source diff reports files and surfaces in plain text", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "src/app.ts", content: "export const value = 1;\n" },
    { path: "pnpm-lock.yaml", content: "lockfileVersion: '9.0'\n" },
  ]);

  const result = runCli(fixture, ["--repo", fixture.repo, "--dry-run"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "runner must not be invoked");
  assert.equal(existsSync(cacheFile(fixture)), false, "no last-review.json may be written");
  assert.match(result.stdout, /mode: branch/);
  assert.match(result.stdout, /src\/app\.ts \(source\)/);
  assert.match(result.stdout, /pnpm-lock\.yaml \(dependency\)/);
  assert.match(result.stdout, /docsOnlyFastPath: false/);
  assert.match(result.stdout, /largePath: false/);
  // The redacted summary must not leak the diff text or the agentsMd body.
  assert.doesNotMatch(result.stdout, /export const value/);
});

test("pr --dry-run reports the PR mode and metadata without a runner or cache", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "src/app.ts", content: "export const value = 1;\n" },
  ]);
  const prNumber = 7;
  const gh = path.join(fixture.fakeBin, "gh");
  writeFileSync(
    gh,
    [
      "#!/usr/bin/env node",
      "const args = process.argv.slice(2);",
      "if (args[0] === 'pr' && args[1] === 'view') {",
      `  process.stdout.write(JSON.stringify({`,
      `    number: ${prNumber},`,
      `    title: 'PR title',`,
      `    body: 'PR body',`,
      `    comments: [],`,
      `    reviews: [],`,
      `    statusCheckRollup: [],`,
      `    baseRefOid: ${JSON.stringify(gitText(["merge-base", "main", "HEAD"], fixture.repo))},`,
      `    headRefOid: ${JSON.stringify(headSha(fixture.repo))},`,
      `    baseRefName: 'main',`,
      `    headRefName: 'feature',`,
      `  }));`,
      "  process.exit(0);",
      "}",
      "process.stderr.write(`unexpected gh args ${args.join(' ')}`);",
      "process.exit(2);",
    ].join("\n")
  );
  chmodSync(gh, 0o755);

  const result = runCli(fixture, ["pr", String(prNumber), "--repo", fixture.repo, "--dry-run", "--json"]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "runner must not be invoked");
  assert.equal(existsSync(cacheFile(fixture)), false, "no last-review.json may be written");
  const summary = parseJsonObject(result.stdout);
  assert.equal(summary.mode, "pr");
  assert.deepEqual(summary.prMeta, { present: true, number: prNumber });
  assert.equal(summary.docsOnlyFastPath, false);
  assert.match(String(summary.reviewTarget), new RegExp(`Review target: PR #${prNumber} `));
});

test("--dry-run --print-bundle prints the full bundle JSON including patch and agentsMd", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "src/app.ts", content: "export const value = 1;\n" },
  ]);

  const result = runCli(fixture, [
    "--repo", fixture.repo, "--dry-run", "--print-bundle",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "runner must not be invoked");
  const bundle = parseJsonObject(result.stdout);
  assert.match(String(bundle.patch), /diff --git a\/src\/app\.ts/);
  assert.match(String(bundle.patch), /\+export const value = 1;/);
  assert.equal(typeof bundle.agentsMd, "string");
  assert.ok(String(bundle.agentsMd).length > 0);
  assert.deepEqual(bundle.changedFiles, [{ path: "src/app.ts", surface: "source" }]);
  assert.equal(existsSync(cacheFile(fixture)), false, "no last-review.json may be written");
});

test("--print-bundle without --dry-run exits nonzero before touching the repo", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "src/app.ts", content: "export const value = 1;\n" },
  ]);

  const result = runCli(fixture, ["--repo", fixture.repo, "--print-bundle"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--print-bundle requires --dry-run/);
  assert.equal(existsSync(fixture.marker), false);
});
