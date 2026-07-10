import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FixtureSpec } from "./shared/types";

// Anti-overfitting lint: the prompts under test must never reference the
// exam. A prompt that names a fixture id or embeds a mustFind pattern is
// tuning to the answer key — the eval would measure memorization, not review
// quality. (Same class of ban as AGENTS.md "no target-repo customization".)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

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

function promptTexts(): Array<[string, string]> {
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => [f, readFileSync(path.join(PROMPTS_DIR, f), "utf8").toLowerCase()]);
}

test("prompts never mention a fixture id", async () => {
  const specs = await loadAll();
  const prompts = promptTexts();
  for (const spec of specs) {
    for (const [file, text] of prompts) {
      assert.ok(!text.includes(spec.id.toLowerCase()), `prompts/${file} references fixture id ${spec.id}`);
    }
  }
});

test("prompts never embed a mustFind/trap pattern verbatim", async () => {
  const specs = await loadAll();
  const prompts = promptTexts();
  for (const spec of specs) {
    const patterns = [...(spec.expected.mustFind ?? []), ...(spec.expected.trap ?? [])].map((m) => m.pattern);
    for (const pattern of patterns) {
      for (const [file, text] of prompts) {
        assert.ok(
          !text.includes(pattern.toLowerCase()),
          `prompts/${file} embeds fixture ${spec.id} pattern verbatim`
        );
      }
    }
  }
});
