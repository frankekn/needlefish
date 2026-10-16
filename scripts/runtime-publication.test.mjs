import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("public version map generates both READMEs idempotently and rejects package/document drift", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"));
  mkdirSync(path.join(root, "eval"));
  for (const file of ["scripts/runtime-publication.mjs", "runtime-publication.json", "package.json", "eval/leaderboard.json", "README.md", "README.zh-TW.md"]) copyFileSync(file, path.join(root, file));
  const run = (...args) => spawnSync(process.execPath, ["scripts/runtime-publication.mjs", ...args], { cwd: root, encoding: "utf8" });
  const initial = run();
  assert.equal(initial.status, 0, initial.stderr);
  const readme = path.join(root, "README.md");
  const original = readFileSync(readme, "utf8");
  assert.equal(run("--write").status, 0);
  assert.equal(readFileSync(readme, "utf8"), original);
  writeFileSync(readme, original.replace("Codex defaults to `medium` effort.", "Codex defaults to `high` effort."));
  const drift = run();
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /run node scripts\/runtime-publication.mjs --write/);
  assert.equal(run("--write").status, 0);
  assert.equal(readFileSync(readme, "utf8"), original);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...pkg, version: "99.0.0" }));
  const version = run();
  assert.equal(version.status, 1);
  assert.match(version.stderr, /package version differs from runtime-publication.json/);
});

test("site check rejects content and version drift without writing, then accepts regeneration", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-site-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const directory of ["eval", "src", "prompts", "scripts"]) cpSync(directory, path.join(root, directory), { recursive: true });
  for (const file of ["runtime-publication.json", "package.json", "README.md", "README.zh-TW.md"]) copyFileSync(file, path.join(root, file));
  symlinkSync(path.resolve("node_modules"), path.join(root, "node_modules"), "dir");
  const run = (...args) => spawnSync(process.execPath, ["--import", "tsx", "eval/gen-site.ts", ...args], { cwd: root, encoding: "utf8" });
  const site = path.join(root, "docs", "index.html");
  const missing = run("--check");
  assert.equal(missing.status, 1);
  assert.equal(existsSync(path.dirname(site)), false);
  const initial = run();
  assert.equal(initial.status, 0, initial.stderr);
  assert.equal(run("--check").status, 0);
  const original = readFileSync(site, "utf8");
  const mutated = original.replace("<title>Needlefish benchmark</title>", "<title>stale site</title>");
  assert.notEqual(mutated, original);
  writeFileSync(site, mutated);
  const contentDrift = run("--check");
  assert.equal(contentDrift.status, 1);
  assert.match(contentDrift.stderr, /docs\/index.html.*run node --import tsx eval\/gen-site.ts/);
  assert.equal(readFileSync(site, "utf8"), mutated);
  assert.equal(run().status, 0);
  assert.equal(readFileSync(site, "utf8"), original);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const publication = JSON.parse(readFileSync(path.join(root, "runtime-publication.json"), "utf8"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ ...pkg, version: "99.0.0" }));
  writeFileSync(path.join(root, "runtime-publication.json"), JSON.stringify({ ...publication, packageVersion: "99.0.0" }));
  const readmes = spawnSync(process.execPath, ["scripts/runtime-publication.mjs", "--write"], { cwd: root, encoding: "utf8" });
  assert.equal(readmes.status, 0, readmes.stderr);
  assert.match(readFileSync(path.join(root, "README.md"), "utf8"), /Package 99\.0\.0/);
  assert.match(readFileSync(path.join(root, "README.zh-TW.md"), "utf8"), /套件 99\.0\.0/);
  const versionDrift = run("--check");
  assert.equal(versionDrift.status, 1);
  assert.match(versionDrift.stderr, /docs\/index.html.*run node --import tsx eval\/gen-site.ts/);
  assert.equal(readFileSync(site, "utf8"), original);
  assert.equal(run().status, 0);
  const regenerated = readFileSync(site, "utf8");
  assert.match(regenerated, /Package 99\.0\.0 uses auto-detect/);
  assert.equal(run("--check").status, 0);
  assert.equal(readFileSync(site, "utf8"), regenerated);
});

test("source install release metadata retains the public distribution map without claiming an effective model", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-release-publication-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  copyFileSync("runtime-publication.json", path.join(root, "runtime-publication.json"));
  const script = readFileSync("scripts/deploy-ubuntu.sh", "utf8");
  const body = script.match(/node - "\$tmp\/repo\/release.json"[^\n]+<<'NODE'\n([\s\S]*?)\nNODE/);
  assert.ok(body);
  const target = path.join(root, "release.json");
  const result = spawnSync(process.execPath, ["-", target, "a".repeat(40), "0.4.10", "https://example.invalid/repo.git", "2026-10-16T00:00:00Z", "v20.0.0"], { input: body[1], cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(readFileSync(target, "utf8"));
  assert.deepEqual(release.runtimePublication, JSON.parse(readFileSync("runtime-publication.json", "utf8")));
  assert.deepEqual(release.runtimePublication.recommendedInstallation, { selection: "operator-selected", identity: "unknown", qualification: "unqualified" });
  assert.equal(release.sha, "a".repeat(40));
});


test("source install reads the cloned public map when invoked from an unrelated working directory", (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-install-cwd-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "source");
  const home = path.join(root, "test-home");
  const caller = path.join(root, "caller");
  const bin = path.join(root, "fakebin");
  for (const dir of [fixture, home, caller, bin, path.join(fixture, "bin")]) mkdirSync(dir, { recursive: true });
  const manifest = JSON.parse(readFileSync("runtime-publication.json", "utf8"));
  writeFileSync(path.join(fixture, "runtime-publication.json"), JSON.stringify(manifest));
  writeFileSync(path.join(caller, "runtime-publication.json"), JSON.stringify({ version: "WRONG-CALLER" }));
  writeFileSync(path.join(fixture, "package.json"), JSON.stringify({ version: manifest.packageVersion }));
  writeFileSync(path.join(fixture, "bin", "needlefish"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(fixture, "bin", "needlefish"), 0o755);
  writeFileSync(path.join(bin, "pnpm"), "#!/bin/sh\nexit 0\n");
  chmodSync(path.join(bin, "pnpm"), 0o755);
  for (const args of [["init", "-b", "main"], ["add", "."], ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-m", "fixture"]]) {
    const git = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    assert.equal(git.status, 0, git.stderr);
  }
  const result = spawnSync("sh", [path.resolve("scripts/deploy-ubuntu.sh")], { cwd: caller, encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`, NEEDLEFISH_REPO_URL: fixture, NEEDLEFISH_REF: "main" } });
  assert.equal(result.status, 0, result.stderr);
  const release = JSON.parse(readFileSync(path.join(home, ".local", "share", "needlefish", "current", "release.json"), "utf8"));
  assert.deepEqual(release.runtimePublication, manifest);
  assert.equal(release.version, manifest.packageVersion);
});
