import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FixtureSpec } from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

async function loadAll(): Promise<FixtureSpec[]> {
  const dirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const specs: FixtureSpec[] = [];
  for (const dir of dirs) {
    const specPath = path.join(FIXTURES_DIR, dir, "spec.ts");
    if (!existsSync(specPath)) continue;
    const mod = await import(pathToFileURL(specPath).href);
    if (mod.default) specs.push(mod.default as FixtureSpec);
  }
  return specs;
}

function lineCount(content: string): number {
  return content.split("\n").length;
}

test("every fixture has a unique id", async () => {
  const specs = await loadAll();
  const ids = specs.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate fixture ids");
});

test("every fixture anchors to a real file with a valid line range", async () => {
  const specs = await loadAll();
  assert.ok(specs.length >= 16, `expected >= 16 fixtures, got ${specs.length}`);
  for (const spec of specs) {
    const anchor = spec.expected.anchorFile;
    if (!anchor) continue;
    const content = spec.headFiles[anchor] ?? spec.baseFiles[anchor];
    assert.ok(content, `${spec.id}: anchorFile ${anchor} not in head or base files`);
    const range = spec.expected.anchorLineRange;
    if (range) {
      const lines = lineCount(content);
      assert.ok(range[0] >= 1 && range[1] <= lines && range[0] <= range[1],
        `${spec.id}: anchorLineRange ${range} invalid for ${anchor} (${lines} lines)`);
    }
  }
});

test("every positive fixture has mustFind; every negative has noBlockingFindings", async () => {
  const specs = await loadAll();
  for (const spec of specs) {
    if (spec.kind === "positive") {
      assert.ok(spec.expected.mustFind?.length, `${spec.id}: positive must have mustFind`);
    } else if (spec.kind === "negative") {
      assert.equal(spec.expected.noBlockingFindings, true, `${spec.id}: negative must set noBlockingFindings`);
    }
  }
});

test("every fixture pattern compiles as a case-insensitive regex", async () => {
  const specs = await loadAll();
  for (const spec of specs) {
    const all = [
      ...(spec.expected.mustFind ?? []),
      ...(spec.expected.mustNotFind ?? []),
      ...(spec.expected.trap ?? []),
    ];
    for (const m of all) {
      assert.doesNotThrow(() => new RegExp(m.pattern, "i"), `${spec.id}: invalid pattern: ${m.pattern}`);
    }
  }
});

test("every positive fixture declares a difficulty tier", async () => {
  const specs = await loadAll();
  for (const spec of specs) {
    if (spec.kind !== "positive") continue;
    assert.ok([1, 2, 3].includes(spec.tier as number), `${spec.id}: positive must set tier 1|2|3`);
  }
});

test("honeypot fixtures: clean verdict, trap set, and trap keywords absent from fixture files", async () => {
  const specs = await loadAll();
  const honeypots = specs.filter((s) => s.kind === "honeypot");
  assert.ok(honeypots.length >= 1, "expected at least one honeypot fixture");
  for (const spec of honeypots) {
    assert.equal(spec.expected.verdict, "pass", `${spec.id}: honeypot diff must be clean`);
    assert.equal(spec.expected.noBlockingFindings, true, `${spec.id}: honeypot must set noBlockingFindings`);
    assert.ok(spec.expected.trap?.length, `${spec.id}: honeypot must set trap patterns`);
    // The whole point: trap keywords must be impossible to produce from the
    // fixture content. If a trap pattern matches any base/head file, the
    // honeypot is broken and cheat detection is meaningless.
    for (const trap of spec.expected.trap ?? []) {
      const re = new RegExp(trap.pattern, "i");
      for (const [name, content] of [...Object.entries(spec.baseFiles), ...Object.entries(spec.headFiles)]) {
        assert.ok(!re.test(content), `${spec.id}: trap pattern leaks into fixture file ${name}`);
      }
    }
  }
});

test("positive fixtures do not hint the bug in comments (leakage guard)", async () => {
  const specs = await loadAll();
  const hintWords = /\b(bug|broken|wrong|fixme|todo|intentional|defect|vulnerab)\b/i;
  for (const spec of specs) {
    if (spec.kind !== "positive") continue;
    for (const [name, content] of Object.entries(spec.headFiles)) {
      for (const line of content.split("\n")) {
        const commentIdx = line.search(/\/\/|#(?!!)|\/\*/);
        if (commentIdx < 0) continue;
        assert.ok(
          !hintWords.test(line.slice(commentIdx)),
          `${spec.id}: head file ${name} comment hints the defect: ${line.trim()}`
        );
      }
    }
  }
});
