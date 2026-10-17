import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isDocsOnlyFastPath } from "../core/review.js";
import { commitAll, gitText, initRepo } from "../shared/codex-runner-test-fixtures.js";
import { diffBundle } from "./local.js";

function directoryBytes(root: string): readonly unknown[] {
  return readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const stat = lstatSync(file);
    return [name, stat.mode, stat.isDirectory() ? directoryBytes(file) : stat.isSymbolicLink() ? readlinkSync(file) : readFileSync(file).toString("base64")];
  });
}

test("captured artifact classifies mode, deletion, copy destination and quoted tracked paths without source writes", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'nf-artifact-"colon:-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  const names = ["mode.ts", "delete.ts", "copy.ts", "space name.ts", 'quote".ts', "tab\t.ts", "line\n.ts", "新功能.ts", "back\\slash.ts"];
  for (const name of names) writeFileSync(path.join(repo, name), "export const value = 1;\n");
  commitAll(repo, "artifact baseline");
  chmodSync(path.join(repo, "mode.ts"), 0o755);
  rmSync(path.join(repo, "delete.ts"));
  gitText(["config", "diff.renames", "copies"], repo);
  writeFileSync(path.join(repo, "destination.ts"), readFileSync(path.join(repo, "copy.ts")));
  gitText(["add", "destination.ts"], repo);
  for (const name of names.slice(3)) writeFileSync(path.join(repo, name), "export const value = 2;\n");
  const before = directoryBytes(repo);
  const scratchBefore = readdirSync(os.tmpdir()).filter(name => name.startsWith("needlefish-captured-patch-"));
  const { bundle } = diffBundle(repo, { localMode: "uncommitted" });
  assert.deepEqual(bundle.changedFiles.map(file => file.path).sort(), [...names.filter(name => name !== "copy.ts"), "destination.ts"].sort());
  assert.equal(isDocsOnlyFastPath(bundle), false);
  assert.match(bundle.patch, /old mode 100644\nnew mode 100755/);
  assert.match(bundle.patchStat, /mode\.ts/);
  assert.deepEqual(directoryBytes(repo), before);
  assert.deepEqual(readdirSync(os.tmpdir()).filter(name => name.startsWith("needlefish-captured-patch-")), scratchBefore);
});

test("omitted source binaries prevent a docs-only classification", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-artifact-binary-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "source.ts"), Buffer.from([0, 1]));
  commitAll(repo, "binary base");
  writeFileSync(path.join(repo, "source.ts"), Buffer.from([0, 2]));
  writeFileSync(path.join(repo, "README.md"), "docs changed\n");
  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.binaryFiles, ["source.ts"]);
  assert.deepEqual(bundle.changedFiles.map(file => file.path), ["README.md", "source.ts"]);
  assert.equal(isDocsOnlyFastPath(bundle), false);
  assert.equal(bundle.patch.includes("source.ts"), false);
});

test("private artifact ignores source diff drivers and hooks while preserving symlink and submodule deltas", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-artifact-config-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const repo = initRepo(tmp);
  symlinkSync("README.md", path.join(repo, "source.ts"));
  gitText(["add", "source.ts"], repo);
  const original = gitText(["rev-parse", "HEAD"], repo);
  gitText(["update-index", "--add", "--cacheinfo", `160000,${original},submodule`], repo);
  gitText(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "link baseline"], repo);
  const next = gitText(["rev-parse", "HEAD"], repo);
  gitText(["update-index", "--cacheinfo", `160000,${next},submodule`], repo);
  rmSync(path.join(repo, "source.ts"));
  symlinkSync("missing-target", path.join(repo, "source.ts"));
  const marker = path.join(tmp, "executed");
  const command = `touch '${marker}'; exit 1`;
  writeFileSync(path.join(repo, ".gitattributes"), "* diff=hostile filter=hostile\n");
  gitText(["config", "filter.hostile.clean", `case "$PWD" in *needlefish-captured-patch-*) ${command};; esac; cat`], repo);
  gitText(["config", "filter.hostile.required", "true"], repo);
  gitText(["config", "diff.hostile.command", command], repo);
  gitText(["config", "diff.hostile.textconv", command], repo);
  gitText(["config", "core.hooksPath", path.join(tmp, "hooks")], repo);
  mkdirSync(path.join(tmp, "hooks"));
  writeFileSync(path.join(tmp, "hooks", "post-index-change"), `#!/bin/sh\n${command}\n`, { mode: 0o755 });
  const overrides = {
    GIT_DIR: path.join(repo, ".git"),
    GIT_WORK_TREE: repo,
    GIT_INDEX_FILE: path.join(repo, ".git", "index"),
    GIT_OBJECT_DIRECTORY: path.join(repo, ".git", "objects"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: path.join(tmp, "hooks"),
  };
  const previous = Object.keys(overrides).map(key => [key, process.env[key]] as const);
  Object.assign(process.env, overrides);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const before = directoryBytes(repo);
  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.changedFiles.map(file => file.path).sort(), [".gitattributes", "source.ts", "submodule"]);
  assert.match(bundle.patch, /Subproject commit/);
  assert.equal(existsSync(marker), false);
  assert.deepEqual(directoryBytes(repo), before);
});

test("unappliable captured binary blocks fail closed and remove private scratch", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-artifact-failure-"));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "README.md"), "changed\n");
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  const wrapper = path.join(bin, "git");
  writeFileSync(wrapper, `#!/usr/bin/env node
const cp = require('node:child_process');
const args = process.argv.slice(2);
const result = cp.spawnSync('/usr/bin/git', args, {encoding:'utf8'});
process.stdout.write(result.stdout ?? '');
if (args[0] === 'diff' && !args.some(arg => ['--numstat', '--stat', '--name-only', '--no-index'].includes(arg))) {
  process.stdout.write('diff --git a/source.ts b/source.ts\\nindex 1111111..2222222 100644\\nBinary files a/source.ts and b/source.ts differ\\n');
}
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous ?? ""}`;
  t.after(() => { process.env.PATH = previous; rmSync(tmp, { recursive: true, force: true }); });
  const before = directoryBytes(repo);
  const scratchBefore = readdirSync(os.tmpdir()).filter(name => name.startsWith("needlefish-captured-patch-"));
  assert.throws(() => diffBundle(repo, {}), /apply.*failed/);
  assert.deepEqual(directoryBytes(repo), before);
  assert.deepEqual(readdirSync(os.tmpdir()).filter(name => name.startsWith("needlefish-captured-patch-")), scratchBefore);
});

test("captured artifact retains the resolved source checkout's protected ownership allowance", t => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "nf-artifact-safe-directory-"));
  const repo = initRepo(tmp);
  writeFileSync(path.join(repo, "README.md"), "changed\n");
  const config = path.join(tmp, "global.gitconfig");
  gitText(["config", "--file", config, "safe.directory", repo], repo);
  const bin = path.join(tmp, "bin");
  mkdirSync(bin);
  writeFileSync(path.join(bin, "git"), `#!/usr/bin/env node
const cp = require('node:child_process');
const env = {...process.env};
if (process.cwd() === ${JSON.stringify(repo)}) env.GIT_TEST_ASSUME_DIFFERENT_OWNER = '1';
const result = cp.spawnSync('/usr/bin/git', process.argv.slice(2), {encoding:'utf8', env});
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousConfig = process.env.GIT_CONFIG_GLOBAL;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.GIT_CONFIG_GLOBAL = config;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousConfig;
    rmSync(tmp, { recursive: true, force: true });
  });
  process.env.GIT_CONFIG_GLOBAL = os.devNull;
  assert.throws(() => diffBundle(repo, {}), /dubious ownership/);
  process.env.GIT_CONFIG_GLOBAL = config;
  assert.equal(gitText(["rev-parse", "--show-toplevel"], repo), repo);
  const before = directoryBytes(repo);
  const { bundle } = diffBundle(repo, {});
  assert.deepEqual(bundle.changedFiles.map(file => file.path), ["README.md"]);
  assert.match(bundle.patch, /\+changed/);
  assert.deepEqual(directoryBytes(repo), before);
});
