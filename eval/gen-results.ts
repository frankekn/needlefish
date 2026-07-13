import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ANTICHEAT_VERSION, type FixtureSpec, type Report } from "./shared/types";

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

export interface NamedReport {
  readonly stem: string;
  readonly report: Report;
}

// The comparability contract, same as resume/compare/weekly: a report earns
// a place in the delta comparison only when its draws ran under the current
// anti-cheat generation and no canary fired. Legacy JSON lacking
// cheatDetectedCount fails the === 0 check — fail closed, never grandfather.
function guarded(r: Report): boolean {
  return (
    r.anticheatVersion === ANTICHEAT_VERSION &&
    r.aggregates.cheatDetectedCount === 0
  );
}

// A fired canary voids the WHOLE report: unlike merely pre-guard (unguarded
// history, shown but incomparable), a compromised report's numbers must not
// be published at all.
function compromised(r: Report): boolean {
  return (r.aggregates.cheatDetectedCount ?? 0) > 0;
}

export function renderResults(specs: FixtureSpec[], reports: NamedReport[]): string {
  const positives = specs.filter((s) => s.kind === "positive");
  const negatives = specs.filter((s) => s.kind === "negative");

  // Reports come from unvalidated disk JSON: a missing/empty hash must not
  // anchor or join a comparison — `undefined === undefined` would publish
  // deltas across unknown fixture sets. Hash presence is part of the gate.
  const hashed = ({ report: r }: NamedReport): boolean =>
    Boolean(r.promptHash) && Boolean(r.fixtureSetHash);
  const comparablePool = reports.filter(
    (nr) => guarded(nr.report) && hashed(nr),
  );
  const baseline =
    comparablePool.find((r) => r.report.runner === "codex" && r.report.effort === "xhigh") ??
    comparablePool[0];
  const comparableWith = (r: Report): boolean =>
    baseline !== undefined &&
    guarded(r) &&
    Boolean(r.promptHash) &&
    Boolean(r.fixtureSetHash) &&
    r.promptHash === baseline.report.promptHash &&
    r.fixtureSetHash === baseline.report.fixtureSetHash;
  const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
  const delta = (b: number, c: number) => `${(c - b) * 100 >= 0 ? "+" : ""}${((c - b) * 100).toFixed(0)}pp`;

  // Provenance must be computed, not asserted: historical results mix prompt
  // generations, and the gated baseline may be absent or not the codex-xhigh
  // run the old prose hardcoded.
  const promptHashes = [...new Set(reports.map((r) => r.report.promptHash))];
  const hashLine =
    promptHashes.length === 1
      ? `All runs share promptHash \`${promptHashes[0]}\`.`
      : promptHashes.length === 0
        ? `No reports loaded.`
        : `⚠️ Mixed prompt hashes across reports (${promptHashes.length} distinct: ${promptHashes.map((h) => `\`${h}\``).join(", ")}); rows whose promptHash differs from the baseline's are not comparable (Δ = n/a).`;
  const baselineLine = baseline
    ? `Baseline = ${baseline.stem} (@${baseline.report.effort ?? "?"}).`
    : `No guarded report qualifies as a baseline — all Δ columns are n/a.`;

  const lines: string[] = [];
  lines.push(`# Eval Results — all runs`);
  lines.push(``);
  lines.push(`${hashLine} ${baselineLine} recall = regex-matched planted-bug hit rate (lower bound on true recall). ⚠️ = partial (draws < 102); its recall/fp are over a biased subset and not directly comparable. 🚫 = pre-guard or compromised report (anticheatVersion ≠ ${ANTICHEAT_VERSION} or cheatDetectedCount > 0); excluded from baseline selection and Δ columns. A compromised report (canary fired) additionally has ALL its metrics withheld — its numbers are void.`);
  lines.push(``);
  lines.push(`## Aggregates (delta vs the baseline above; full runs only)`);
  lines.push(``);
  lines.push(`| model | @effort | draws | recall | Δrecall | fp | invalidJson | mean dur | fail |`);
  lines.push(`|---|---|---|---|---|---|---|---|---|`);
  for (const { stem, report: r } of reports) {
    const a = r.aggregates;
    const draws = r.results.length;
    if (compromised(r)) {
      lines.push(`| 🚫 ${stem} | @${r.effort ?? "?"} | ${draws}/102 | COMPROMISED | n/a | — | — | — | — |`);
      continue;
    }
    const partial = draws < 102;
    const d =
      baseline && r === baseline.report
        ? "(baseline)"
        : !comparableWith(r)
          ? "n/a"
          : partial
            ? "—"
            : delta(baseline!.report.aggregates.recall, a.recall);
    const mark = `${guarded(r) ? "" : "🚫 "}${partial ? "⚠️ " : ""}`;
    lines.push(`| ${mark}${stem} | @${r.effort ?? "?"} | ${draws}/102 | ${pct(a.recall)} | ${d} | ${pct(a.falsePositiveRate)} | ${pct(a.invalidJsonRate)} | ${Math.round(a.meanDurationMs / 1000)}s | ${r.results.filter((x) => !x.score.formatOk).length} |`);
  }
  lines.push(``);
  lines.push(`## Recall by positive fixture (hit rate over 3 draws)`);
  lines.push(``);
  lines.push(`| fixture | ${reports.map((r) => r.stem).join(" | ")} |`);
  lines.push(`|---|${reports.map(() => "---").join("|")}|`);
  for (const p of positives) {
    const cells = reports.map(({ report: r }) => {
      if (compromised(r)) return "—";
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
    if (compromised(r)) continue;
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
    if (compromised(r)) continue;
    const fps = negatives.filter((n) => r.results.some((x) => x.fixtureId === n.id && x.score.falsePositive));
    if (fps.length === 0) continue;
    lines.push(`**${stem}**: ${fps.map((n) => n.id).join(", ")}`);
  }
  lines.push(``);
  lines.push(`## Notes`);
  lines.push(`- **Runner reliability confound (opencode @ max):** high invalidJson = timeout/parse fail from opencode's agentic loop, not model quality. Proven by grok-build-0.1: opencode agentic = 12% recall / 56% invalidJson; same model via direct single-shot (openai runner) = 47% recall / 2% invalidJson. opencode @ max numbers are runner-confounded — treat as lower bounds, not model quality.`);
  lines.push(`- **Partials (⚠️):** grok-build-0.1-direct = 98/102 (4 draws lost to grok outage on sql-data-migration-break); grok-composer-2.5-fast = 52/102 (skipped mid-run, grok instability). Their recall/fp are over completed draws only.`);
  lines.push(`- recall is a regex lower bound; a model may have found the bug with different wording and still scored 0. Use \`eval/inspect.ts <fixture-id>\` to verify specific misses.`);
  lines.push(`- codex medium (76%) ≈ high (74%) within 3-draw noise — reasoning effort is not monotonic in recall here.`);
  lines.push(`- claude opus-47 (76%) > opus-48 (64%) — newer opus regressed on this set.`);

  return lines.join("\n") + "\n";
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const specs = await loadSpecs();
  const reportFiles = readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json") && !f.startsWith("run-"))
    .sort();
  const reports: NamedReport[] = reportFiles.map((f) => ({
    stem: f.replace(/\.json$/, ""),
    report: JSON.parse(readFileSync(path.join(RESULTS_DIR, f), "utf8")) as Report,
  }));
  writeFileSync(path.join(__dirname, "RESULTS.md"), renderResults(specs, reports));
  process.stderr.write(`wrote eval/RESULTS.md (${reports.length} models)\n`);
}
