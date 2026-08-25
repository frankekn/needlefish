import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadFixtures } from "./run";

// Anti-overfitting lint: the prompts under test must never reference the
// exam. A prompt that names a fixture id or embeds a mustFind pattern is
// tuning to the answer key — the eval would measure memorization, not review
// quality. (Same class of ban as AGENTS.md "no target-repo customization".)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.join(__dirname, "..", "prompts");

function promptTexts(): Array<[string, string]> {
  return readdirSync(PROMPTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .map((f) => [f, readFileSync(path.join(PROMPTS_DIR, f), "utf8").toLowerCase()]);
}

test("prompts never mention a fixture id", async () => {
  const specs = await loadFixtures(null);
  const prompts = promptTexts();
  for (const spec of specs) {
    for (const [file, text] of prompts) {
      assert.ok(!text.includes(spec.id.toLowerCase()), `prompts/${file} references fixture id ${spec.id}`);
    }
  }
});

test("anti-leakage fixture source includes fixtures-real", async () => {
  const specs = await loadFixtures(null);
  assert.ok(
    specs.some((spec) => spec.id === "real-pr1-token-leak"),
    "eval/fixtures-real must be included in anti-leakage checks"
  );
});

test("prompts never embed a mustFind/trap pattern verbatim", async () => {
  const specs = await loadFixtures(null);
  const prompts = promptTexts();
  for (const spec of specs) {
    const alternatives = [...(spec.expected.mustFind ?? []), ...(spec.expected.trap ?? [])]
      .flatMap((m) => m.pattern === undefined
        ? (m.facts ?? []).flatMap((fact) => fact.alternatives.map((alternative) => alternative.allOf))
        : [[m.pattern]]);
    for (const patterns of alternatives) {
      for (const [file, text] of prompts) {
        assert.ok(
          !patterns.every((pattern) => text.includes(pattern.toLowerCase())),
          `prompts/${file} embeds fixture ${spec.id} matcher alternative verbatim`
        );
      }
    }
  }
});
