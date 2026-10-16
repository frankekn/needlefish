import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  assert.equal(run().status, 0);
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
