import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  buildSpecSource,
  checkCaps,
  checkOverwrite,
  deriveSlug,
  isBinaryContent,
  mapKind,
  parseCliArgs,
} from "./pr2fixture";

test("parseCliArgs: valid full invocation parses correctly", () => {
  const args = parseCliArgs([
    "--repo", "owner/name",
    "--pr", "1234",
    "--out", "eval/fixtures-real/my-slug/",
    "--kind", "review-finding",
  ]);
  assert.deepEqual(args, { repo: "owner/name", pr: 1234, out: "eval/fixtures-real/my-slug/", kind: "review-finding", force: false });
});

test("parseCliArgs: --force is captured", () => {
  const args = parseCliArgs(["--repo", "o/n", "--pr", "1", "--out", "eval/fixtures-real/x/", "--kind", "clean-negative", "--force"]);
  assert.equal((args as { force: boolean }).force, true);
});

test("parseCliArgs: --help returns { help: true } without other flags", () => {
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
});

test("parseCliArgs: missing --repo throws", () => {
  assert.throws(() => parseCliArgs(["--pr", "1", "--out", "x", "--kind", "revert"]), /--repo is required/);
});

test("parseCliArgs: missing --pr throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--out", "x", "--kind", "revert"]), /--pr is required/);
});

test("parseCliArgs: missing --out throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "1", "--kind", "revert"]), /--out is required/);
});

test("parseCliArgs: missing --kind throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "1", "--out", "x"]), /--kind is required/);
});

test("parseCliArgs: non-numeric --pr throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "abc", "--out", "x", "--kind", "revert"]), /--pr must be a positive integer/);
});

test("parseCliArgs: non-positive --pr throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "0", "--out", "x", "--kind", "revert"]), /--pr must be a positive integer/);
});

test("parseCliArgs: invalid --kind throws", () => {
  assert.throws(() => parseCliArgs(["--repo", "o/n", "--pr", "1", "--out", "x", "--kind", "nonsense"]), /--kind must be one of/);
});

test("deriveSlug: extracts kebab-case slug, trailing slash tolerated", () => {
  assert.equal(deriveSlug("eval/fixtures-real/my-slug/"), "my-slug");
  assert.equal(deriveSlug("eval/fixtures-real/my-slug"), "my-slug");
});

test("deriveSlug: rejects uppercase, underscores, leading hyphen", () => {
  assert.throws(() => deriveSlug("eval/fixtures-real/MySlug/"), /kebab-case/);
  assert.throws(() => deriveSlug("eval/fixtures-real/my_slug/"), /kebab-case/);
  assert.throws(() => deriveSlug("eval/fixtures-real/-my-slug/"), /kebab-case/);
});

test("mapKind: clean-negative maps to negative, everything else to positive", () => {
  assert.equal(mapKind("clean-negative"), "negative");
  assert.equal(mapKind("review-finding"), "positive");
  assert.equal(mapKind("post-merge-fix"), "positive");
  assert.equal(mapKind("revert"), "positive");
});

test("checkCaps: a file over the per-file cap fails, names the file", () => {
  const result = checkCaps([{ path: "src/big.ts", bytes: 51 * 1024 }]);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /src\/big\.ts/);
});

test("checkCaps: total over the cap fails even with small individual files", () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.ts`, bytes: 45 * 1024 }));
  const result = checkCaps(files);
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /total/);
});

test("checkCaps: files under both caps pass", () => {
  const result = checkCaps([{ path: "a.ts", bytes: 1024 }, { path: "b.ts", bytes: 2048 }]);
  assert.equal(result.ok, true);
});

test("checkOverwrite: throws when spec.ts exists and force is false", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-test-"));
  try {
    writeFileSync(path.join(tmp, "spec.ts"), "x");
    assert.throws(() => checkOverwrite(tmp, false), /already exists/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkOverwrite: no-op when force is true", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-test-"));
  try {
    writeFileSync(path.join(tmp, "spec.ts"), "x");
    assert.doesNotThrow(() => checkOverwrite(tmp, true));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("checkOverwrite: no-op when the directory doesn't exist yet", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-test-"));
  rmSync(tmp, { recursive: true, force: true });
  assert.doesNotThrow(() => checkOverwrite(tmp, false));
});

test("isBinaryContent: NUL byte detected as binary", () => {
  assert.equal(isBinaryContent(Buffer.from([0x48, 0x69, 0x00, 0x21])), true);
});

test("isBinaryContent: plain utf8 text is not binary", () => {
  assert.equal(isBinaryContent(Buffer.from("hello world\n", "utf8")), false);
});

test("buildSpecSource: positive skeleton contains placeholder pattern and curator header", () => {
  const src = buildSpecSource({
    id: "my-slug",
    kind: "positive",
    provenance: { repo: "owner/name", pr: 42, kind: "review-finding", evidenceUrl: "https://example.com/pr/42" },
    prTitle: "Fix the thing",
    prUrl: "https://example.com/pr/42",
    baseFiles: { "src/a.ts": "old" },
    headFiles: { "src/a.ts": "new" },
  });
  assert.match(src, /kind: "positive"/);
  assert.match(src, /TODO-CURATOR-PATTERN/);
  assert.match(src, /GENERATED SKELETON/);
  assert.match(src, /provenance: \{ repo: "owner\/name", pr: 42, kind: "review-finding"/);
});

test("buildSpecSource: negative skeleton has noBlockingFindings, no curator pattern placeholder", () => {
  const src = buildSpecSource({
    id: "my-clean-slug",
    kind: "negative",
    provenance: { repo: "owner/name", pr: 7, kind: "clean-negative" },
    prTitle: "Safe refactor",
    prUrl: "https://example.com/pr/7",
    baseFiles: {},
    headFiles: {},
  });
  assert.match(src, /kind: "negative"/);
  assert.match(src, /noBlockingFindings: true/);
  assert.ok(!src.includes("TODO-CURATOR-PATTERN"));
});

interface ToolRun {
  readonly status: number | null;
  readonly stderr: string;
  readonly source: string | null;
}

function runTool(mode: "success" | "flat-pages" | "404" | "500" | "invalid-json"): ToolRun {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "pr2fixture-cli-test-"));
  const binDir = path.join(tmp, "bin");
  const outDir = path.join(tmp, "renamed-fixture");
  try {
    writeFileSync(path.join(tmp, "gh"), `#!/usr/bin/env node
const args = process.argv.slice(2);
const endpoint = args[1] ?? "";
const mode = ${JSON.stringify(mode)};
if (endpoint === "repos/owner/name/pulls/7") {
  process.stdout.write(JSON.stringify({ base: { sha: "base" }, head: { sha: "head" }, title: "Rename", html_url: "https://example.test/pr/7" }));
} else if (endpoint.endsWith("/pulls/7/files")) {
  if (!args.includes("--paginate") || !args.includes("--slurp")) {
    process.stderr.write("files request must use --paginate --slurp\\n");
    process.exit(2);
  }
  const pages = [[{ filename: "src/new.ts", previous_filename: "src/old.ts", status: "renamed" }], [{ filename: "src/added.ts", status: "added" }]];
  process.stdout.write(JSON.stringify(mode === "flat-pages" ? pages.flat() : pages));
} else if (endpoint.includes("/contents/src/old.ts?ref=base")) {
  process.stdout.write(JSON.stringify({ encoding: "base64", content: Buffer.from("old content").toString("base64") }));
} else if (endpoint.includes("/contents/src/new.ts?ref=head")) {
  if (mode === "404" || mode === "500") {
    process.stderr.write(mode === "404" ? "gh: Not Found (HTTP 404)\\n" : "gh: server failed (HTTP 500)\\n");
    process.exit(1);
  }
  if (mode === "invalid-json") process.stdout.write("not json");
  else process.stdout.write(JSON.stringify({ encoding: "base64", content: Buffer.from("new content").toString("base64") }));
} else if (endpoint.includes("/contents/src/added.ts?ref=head")) {
  process.stdout.write(JSON.stringify({ encoding: "base64", content: Buffer.from("added content").toString("base64") }));
} else {
  process.stderr.write("unexpected gh invocation: " + args.join(" ") + "\\n");
  process.exit(3);
}
`);
    mkdirSync(binDir);
    renameSync(path.join(tmp, "gh"), path.join(binDir, "gh"));
    chmodSync(path.join(binDir, "gh"), 0o755);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.resolve("eval/tools/pr2fixture.ts"), "--repo", "owner/name", "--pr", "7", "--out", outDir, "--kind", "review-finding"],
      { encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` } }
    );
    const specPath = path.join(outDir, "spec.ts");
    return {
      status: result.status,
      stderr: result.stderr,
      source: result.status === 0 ? readFileSync(specPath, "utf8") : null,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("CLI: slurps paginated files and preserves both paths for a rename", () => {
  const result = runTool("success");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.source ?? "", /"src\/old\.ts": "old content"/);
  assert.match(result.source ?? "", /"src\/new\.ts": "new content"/);
  assert.match(result.source ?? "", /"src\/added\.ts": "added content"/);
});

test("CLI: accepts gh versions that return one merged array with pagination", () => {
  const result = runTool("flat-pages");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.source ?? "", /"src\/old\.ts": "old content"/);
  assert.match(result.source ?? "", /"src\/added\.ts": "added content"/);
});

test("CLI: a missing file response is skipped", () => {
  const result = runTool("404");
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.source ?? "", /"src\/new\.ts"/);
});

test("CLI: non-404 gh failures abort fixture generation", () => {
  const result = runTool("500");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /HTTP 500/);
});

test("CLI: malformed contents JSON aborts fixture generation", () => {
  const result = runTool("invalid-json");
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected token|JSON/);
});
