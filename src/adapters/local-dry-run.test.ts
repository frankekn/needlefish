import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
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

function runCli(fixture: DryRunFixture, args: readonly string[], overrides: NodeJS.ProcessEnv = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${fixture.fakeBin}:${process.env.PATH ?? ""}`,
    HOME: fixture.home,
    CLAUDE_BIN: "claude",
    NEEDLEFISH_RUNNER: "claude",
    ...overrides,
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
  assert.match(result.stdout, /capability: claude: repositoryRead/);
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

test("docs-only --deep --dry-run reports the fast path, not the large path", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "docs/guide.md", content: "guide\n" },
  ]);

  const result = runCli(fixture, [
    "--repo", fixture.repo, "--deep", "--dry-run", "--json",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "runner must not be invoked");
  const summary = parseJsonObject(result.stdout);
  assert.equal(summary.docsOnlyFastPath, true);
  assert.equal(
    summary.largePath,
    false,
    "--deep on a docs-only diff still takes the fast path in review(); the dry-run plan must match",
  );
});

test("--dry-run with a nested --repo collects root-relative tracked and untracked changes", (t) => {
  const fixture = setupDryRunFixture(t, [
    { path: "app.ts", content: "export const app = 1;\n" },
    { path: "pkg/deep/mod.ts", content: "export const mod = 1;\n" },
  ]);
  // Dirty both scopes after the fixture commit: tracked edits plus untracked
  // files, outside and inside the nested directory.
  writeFileSync(path.join(fixture.repo, "app.ts"), "export const app = 2;\n");
  writeFileSync(path.join(fixture.repo, "pkg", "deep", "mod.ts"), "export const mod = 2;\n");
  writeFileSync(path.join(fixture.repo, "newroot.ts"), "export const newroot = 1;\n");
  writeFileSync(path.join(fixture.repo, "pkg", "deep", "newmod.ts"), "export const newmod = 1;\n");

  const result = runCli(fixture, [
    "--repo",
    path.join(fixture.repo, "pkg", "deep"),
    "--dry-run",
    "--print-bundle",
  ]);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(fixture.marker), false, "runner must not be invoked");
  assert.equal(existsSync(cacheFile(fixture)), false, "no last-review.json may be written");
  const bundle = parseJsonObject(result.stdout);
  assert.equal(bundle.repoPath, fixture.repo, "the bundle must point at the repository root");
  const patch = String(bundle.patch);
  assert.match(patch, /diff --git a\/app\.ts b\/app\.ts/);
  assert.match(patch, /diff --git a\/pkg\/deep\/mod\.ts b\/pkg\/deep\/mod\.ts/);
  assert.match(patch, /diff --git a\/newroot\.ts b\/newroot\.ts/);
  assert.match(patch, /diff --git a\/pkg\/deep\/newmod\.ts b\/pkg\/deep\/newmod\.ts/);
  const changed = bundle.changedFiles;
  assert.ok(Array.isArray(changed));
  const paths = changed
    .map((file) => (isJsonObject(file) && typeof file.path === "string" ? file.path : ""))
    .sort();
  assert.deepEqual(paths, ["app.ts", "newroot.ts", "pkg/deep/mod.ts", "pkg/deep/newmod.ts"]);
});

for (const runner of [undefined, "invalid-runner"]) {
  test(`dry-run prints its bundle when runner selection is unresolved (${runner ?? "auto"})`, (t) => {
    const fixture = setupDryRunFixture(t, [{ path: "app.ts", content: "export const value = 1;\n" }]);
    const gitOnlyBin = path.join(fixture.tmp, "git-only-bin");
    mkdirSync(gitOnlyBin);
    const commands = process.platform === "linux" ? ["git", "flock", "sh", "true"] : ["git"];
    for (const command of commands) {
      const resolved = spawnSync("which", [command], { encoding: "utf8" });
      assert.equal(resolved.status, 0, resolved.stderr);
      symlinkSync(resolved.stdout.trim(), path.join(gitOnlyBin, command));
    }
    const env = {
      PATH: gitOnlyBin,
      NEEDLEFISH_RUNNER: runner,
      CODEX_BIN: "codex",
      CLAUDE_BIN: "claude",
      OPENCODE_BIN: "opencode",
    };
    const args = ["--repo", fixture.repo];
    const dry = runCli(fixture, [...args, "--dry-run", "--json"], env);
    assert.equal(dry.status, 0, dry.stderr);
    const summary = parseJsonObject(dry.stdout);
    assert.deepEqual(summary.changedFiles, [{ path: "app.ts", surface: "source" }]);
    const capability = summary.capability;
    assert.ok(isJsonObject(capability));
    assert.equal(capability.capability, "unresolved");
    const plain = runCli(fixture, [...args, "--dry-run"], env);
    assert.equal(plain.status, 0, plain.stderr);
    assert.match(plain.stdout, /capability: unresolved;/);
    if (runner === undefined) {
      assert.match(plain.stdout, /\ncapability: unresolved; No supported model runner found on PATH\.\n {2}Install one:\n(?: {4}\S+: [^\n]+\n)+$/);
    }
    const actual = runCli(fixture, args, env);
    assert.equal(actual.status, 1, actual.stderr);
    assert.equal(actual.stderr.trim(), `needlefish: ${capability.detail}`);
    assert.equal(existsSync(fixture.marker), false);
    assert.equal(existsSync(cacheFile(fixture)), false);
  });
}

test("HTTP dry-run renders its unsupported decision before rejecting the same small critic as actual review", (t) => {
  const fixture = setupDryRunFixture(t, [{ path: "app.ts", content: "export const value = 1;\n" }]);
  const args = ["--repo", fixture.repo, "--runner", "openai"];
  const env = { OPENAI_API_KEY: "local-test-placeholder", OPENAI_BASE_URL: "http://127.0.0.1:1/v1" };
  const actual = runCli(fixture, args, env);
  assert.equal(actual.status, 1, actual.stderr);
  for (const format of [[], ["--json"], ["--print-bundle"]]) {
    const dry = runCli(fixture, [...args, "--dry-run", ...format], env);
    assert.equal(dry.status, 1, dry.stderr);
    assert.equal(dry.stderr, actual.stderr);
    assert.match(dry.stderr, /unsupported-capability.*repositoryRead/);
    if (format.includes("--json")) {
      const summary = parseJsonObject(dry.stdout);
      const capability = summary.capability;
      assert.ok(isJsonObject(capability));
      assert.equal(capability.capability, "promptOnly");
      assert.equal(`needlefish: ${capability.detail}`, dry.stderr.trim());
      assert.deepEqual(summary.changedFiles, [{ path: "app.ts", surface: "source" }]);
    } else if (format.includes("--print-bundle")) {
      assert.match(String(parseJsonObject(dry.stdout).patch), /export const value = 1/);
    } else {
      assert.match(dry.stdout, /app\.ts \(source\)/);
      assert.match(dry.stdout, /capability: unsupported-capability/);
    }
  }
  assert.equal(existsSync(fixture.marker), false);
  assert.equal(existsSync(cacheFile(fixture)), false);
});


test("ACP dry-run reports unknown repository capability without launching the agent", (t) => {
  const fixture = setupDryRunFixture(t, [{ path: "app.ts", content: "export const value = 1;\n" }]);
  const result = runCli(fixture, ["--repo", fixture.repo, "--runner", "acp", "--dry-run", "--json"], {
    NEEDLEFISH_ACP_BIN: path.join(fixture.fakeBin, "claude"),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseJsonObject(result.stdout).capability, {
    runner: "acp",
    capability: "unknown",
    detail: "acp: repository capability unknown; protocol initialize does not verify repositoryRead. The configured launcher remains experimental.",
  });
  assert.equal(existsSync(fixture.marker), false);
});
