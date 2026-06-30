import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FixtureSpec, Report } from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = path.join(__dirname, "results");
const FIXTURES_DIR = path.join(__dirname, "fixtures");

async function loadSpecs(): Promise<FixtureSpec[]> {
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

const specs = await loadSpecs();
const specById = new Map(specs.map((s) => [s.id, s]));
const positives = specs.filter((s) => s.kind === "positive");
const negatives = specs.filter((s) => s.kind === "negative");

const reportFiles = readdirSync(RESULTS_DIR)
  .filter((f) => f.endsWith(".json") && !f.startsWith("run-"))
  .sort();
const reports = reportFiles.map((f) => ({
  stem: f.replace(/\.json$/, ""),
  report: JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf8")) as Report,
}));

const baseline = reports.find((r) => r.report.runner === "codex" && r.report.effort === "xhigh") ?? reports[0];
const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const delta = (b: number, c: number) => `${(c - b) * 100 >= 0 ? "+" : ""}${((c - b) * 100).toFixed(0)}pp`;

const lines: string[] = [];
lines.push(`# Eval Results — 10 models × 3 draws`);
lines.push(``);
lines.push(`All runs share promptHash \`${reports[0].report.promptHash}\`. Baseline = codex gpt-5.5 @ xhigh. recall = regex-matched planted-bug hit rate (lower bound on true recall).`);
lines.push(``);
lines.push(`## Aggregates (delta vs codex-xhigh baseline)`);
lines.push(``);
lines.push(`| model | @effort | recall | Δrecall | fp | invalidJson | mean dur | fail |`);
lines.push(`|---|---|---|---|---|---|---|---|`);
for (const { stem, report: r } of reports) {
  const a = r.aggregates;
  const d = r === baseline.report ? "(baseline)" : delta(baseline.report.aggregates.recall, a.recall);
  lines.push(`| ${stem} | @${r.effort ?? "?"} | ${pct(a.recall)} | ${d} | ${pct(a.falsePositiveRate)} | ${pct(a.invalidJsonRate)} | ${Math.round(a.meanDurationMs / 1000)}s | ${r.results.filter((x) => !x.score.formatOk).length} |`);
}
lines.push(``);
lines.push(`## Recall by positive fixture (hit rate over 3 draws)`);
lines.push(``);
lines.push(`| fixture | ${reports.map((r) => r.stem).join(" | ")} |`);
lines.push(`|---|${reports.map(() => "---").join("|")}|`);
for (const p of positives) {
  const cells = reports.map(({ report: r }) => {
    const draws = r.results.filter((x) => x.fixtureId === p.id);
    const hits = draws.filter((x) => x.score.recall).length;
    return `${hits}/${draws.length}`;
  });
  lines.push(`| ${p.id} | ${cells.join(" | ")} |`);
}
lines.push(``);
lines.push(`## Stable misses (recall=false on all 3 draws) — by model`);
lines.push(``);
for (const { stem, report: r } of reports) {
  const stable = positives.filter((p) => {
    const draws = r.results.filter((x) => x.fixtureId === p.id);
    return draws.length === 3 && draws.every((x) => !x.score.recall);
  });
  if (stable.length === 0) continue;
  lines.push(`**${stem}** (${stable.length}): ${stable.map((p) => p.id).join(", ")}`);
}
lines.push(``);
lines.push(`## False positives (fp=true on any draw) — by model`);
lines.push(``);
for (const { stem, report: r } of reports) {
  const fps = negatives.filter((n) => r.results.some((x) => x.fixtureId === n.id && x.score.falsePositive));
  if (fps.length === 0) continue;
  lines.push(`**${stem}**: ${fps.map((n) => n.id).join(", ")}`);
}
lines.push(``);
lines.push(`## Notes`);
lines.push(`- opencode @ max: high invalidJson = timeout/parse fail (4-min timeout + no-retry for qwen/grok; 10-min + 2x retry for glm52/deepseek/kimi). Not model quality — runner/variant reliability.`);
lines.push(`- recall is a regex lower bound; a model may have found the bug with different wording and still scored 0. Use \`eval/inspect.ts <fixture-id>\` to verify specific misses.`);
lines.push(`- codex medium (76%) ≈ high (74%) within 3-draw noise — reasoning effort is not monotonic in recall here.`);

writeFileSync(path.join(__dirname, "RESULTS.md"), lines.join("\n") + "\n");
process.stderr.write(`wrote eval/RESULTS.md (${lines.length} lines, ${reports.length} models)\n`);
