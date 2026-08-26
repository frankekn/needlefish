import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { RUNNERS } from "../src/shared/runner.ts";
import {
  installRunner,
  readRunnerCatalog,
  resolveRunnerInstall,
  runnerBinaryPath,
  validateRunnerCatalog,
} from "./setup-runner.mjs";

const catalog = validateRunnerCatalog(readRunnerCatalog());

test("runner catalog covers the runtime runner contract exactly", () => {
  assert.deepEqual(Object.keys(catalog).sort(), [...RUNNERS].sort());
  assert.deepEqual(
    Object.entries(catalog)
      .filter(([, entry]) => entry.hostedInstall)
      .map(([runner]) => runner)
      .sort(),
    ["claude", "codex", "opencode", "pi"],
  );
  assert.deepEqual(
    Object.entries(catalog)
      .filter(([, entry]) => entry.autoDetectOrder !== null)
      .sort(([, a], [, b]) => a.autoDetectOrder - b.autoDetectOrder)
      .map(([runner]) => runner),
    ["codex", "claude", "opencode"],
  );
});

test("runner catalog keeps hosted package identity and pins in one place", () => {
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(catalog)
        .filter(([, entry]) => entry.hostedInstall)
        .map(([runner, entry]) => [
          runner,
          [entry.hostedInstall.npmPackage, entry.hostedInstall.defaultVersion],
        ]),
    ),
    {
      codex: ["@openai/codex", "0.149.0"],
      claude: ["@anthropic-ai/claude-code", "2.1.239"],
      opencode: ["opencode-ai", "1.18.21"],
      pi: ["@mariozechner/pi", "0.70.6"],
    },
  );
});

test("resolveRunnerInstall uses the official default and accepts an intentional override", () => {
  assert.equal(resolveRunnerInstall("codex").version, "0.149.0");
  assert.equal(resolveRunnerInstall("codex", "latest").version, "latest");
  assert.equal(resolveRunnerInstall("codex", "0.150.0-alpha.11").version, "0.150.0-alpha.11");
});

test("resolveRunnerInstall rejects unknown, external-only, and path-like versions", () => {
  assert.throws(() => resolveRunnerInstall("missing"), /unknown runner/);
  assert.throws(() => resolveRunnerInstall("grok"), /no managed npm install/);
  assert.throws(() => resolveRunnerInstall("codex", "../../package"), /without paths/);
  assert.throws(() => resolveRunnerInstall("codex", "next\nEVIL=1"), /without paths/);
});

test("runnerBinaryPath handles POSIX and Windows npm shims", () => {
  assert.equal(runnerBinaryPath("/tmp/install", "codex", "linux"), "/tmp/install/node_modules/.bin/codex");
  assert.equal(
    runnerBinaryPath("C:\\install", "codex", "win32"),
    join("C:\\install", "node_modules", ".bin", "codex.cmd"),
  );
});

test("installRunner uses job-local storage and exports the selected executable", () => {
  const root = mkdtempSync(join(tmpdir(), "needlefish-setup-runner-"));
  const githubPath = join(root, "github-path");
  const githubOutput = join(root, "github-output");
  const calls = [];
  try {
    const result = installRunner({
      runner: "codex",
      runnerTemp: root,
      githubPath,
      githubOutput,
      platform: "linux",
      arch: "x64",
      spawn(command, args, options) {
        calls.push({ command, args, options });
        const prefix = args[args.indexOf("--prefix") + 1];
        const binary = runnerBinaryPath(prefix, "codex", "linux");
        mkdirSync(dirname(binary), { recursive: true });
        writeFileSync(binary, "#!/bin/sh\nexit 0\n");
        chmodSync(binary, 0o755);
        const packageManifest = join(prefix, "node_modules", "@openai", "codex", "package.json");
        mkdirSync(dirname(packageManifest), { recursive: true });
        writeFileSync(packageManifest, '{"version":"0.149.0"}\n');
        return { status: 0 };
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "npm");
    assert.deepEqual(calls[0].args.slice(0, 5), [
      "install",
      "--no-save",
      "--no-audit",
      "--no-fund",
      "--prefix",
    ]);
    assert.equal(calls[0].args.at(-1), "@openai/codex@0.149.0");
    assert.ok(result.installRoot.startsWith(root));
    assert.equal(readFileSync(githubPath, "utf8"), `${result.binDir}\n`);
    assert.equal(
      readFileSync(githubOutput, "utf8"),
      `runner=codex\nversion=0.149.0\nbinary_path=${result.binaryPath}\n`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installRunner fails when npm does not create the declared binary", () => {
  const root = mkdtempSync(join(tmpdir(), "needlefish-setup-runner-"));
  try {
    assert.throws(
      () =>
        installRunner({
          runner: "codex",
          runnerTemp: root,
          platform: "linux",
          arch: "x64",
          spawn: () => ({ status: 0 }),
        }),
      /binary is missing or not executable/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
