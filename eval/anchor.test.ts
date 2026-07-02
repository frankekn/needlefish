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
