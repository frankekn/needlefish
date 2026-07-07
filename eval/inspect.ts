import { review } from "../src/core/review";
import { loadFixture } from "./shared/fixture";
import { matchesSpec } from "./shared/score";
import type { MatchSpec } from "./shared/types";
import { promptHash } from "./shared/prompt-hash";
import { pathToFileURL } from "node:url";
import path from "node:path";

const FIXTURES_DIR = path.join(path.dirname(path.dirname(new URL(import.meta.url).pathname)), "eval", "fixtures");

async function loadOne(id: string) {
  const specPath = path.join(FIXTURES_DIR, id, "spec.ts");
  const mod = await import(pathToFileURL(specPath).href);
  return mod.default;
}

const id = process.argv[2];
if (!id) {
  process.stderr.write("usage: inspect.ts <fixture-id>\n");
  process.exit(1);
}

const spec = await loadOne(id);
process.stderr.write(`fixture: ${spec.id} | promptHash: ${promptHash()}\n`);
process.stderr.write(`expected verdict: ${spec.expected.verdict}\n`);
process.stderr.write(`mustFind patterns: ${(spec.expected.mustFind ?? []).map((m: MatchSpec) => m.pattern).join(" | ")}\n\n`);

const loaded = loadFixture(spec);
try {
  const result = await review(loaded.bundle, { runner: "codex" });
  process.stdout.write(`verdict: ${result.verdict}\n`);
  process.stdout.write(`findings: ${result.findings.length}\n\n`);
  for (const f of result.findings) {
    const matched = (spec.expected.mustFind ?? []).some((m: MatchSpec) => matchesSpec(f, m));
    process.stdout.write(`  [${f.severity}/${f.category}] ${matched ? "MATCH" : "no-match"} ${f.file}:${f.lineStart}\n`);
    process.stdout.write(`    title: ${f.title}\n`);
    process.stdout.write(`    why:   ${f.whyItBreaks.slice(0, 200)}\n\n`);
  }
  if (result.findings.length === 0) {
    process.stdout.write("  (no findings — model returned clean)\n");
  }
} catch (err) {
  process.stderr.write(`review failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
} finally {
  loaded.cleanup();
}
