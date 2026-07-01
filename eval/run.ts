import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { review } from "../src/core/review";
import type { RunnerName } from "../src/shared/runner";
import type { Bundle, ReviewResult } from "../src/shared/schema";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { score } from "./shared/score";
import type {
  Aggregates,
  DrawResult,
  FixtureSpec,
  Report,
} from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

interface RunArgs {
  runner: RunnerName;
  model: string | null;
  effort: string | null;
  draws: number;
  baseline: boolean;
  report: string;
  dryRun: boolean;
  compare: string | null;
  fixtures: string | null;
  resume: string | null;
}

function parseArgs(argv: readonly string[]): RunArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const runner = get("--runner") ?? "codex";
  if (runner !== "codex" && runner !== "claude" && runner !== "opencode" && runner !== "openai") {
    throw new Error(`--runner must be codex|claude|opencode|openai, got: ${runner}`);
  }
  const model = get("--model");
  const effort = get("--effort");
  const draws = Number(get("--draws") ?? "1");
  if (!Number.isInteger(draws) || draws < 1) throw new Error("--draws must be a positive integer");
  const baseline = argv.includes("--baseline");
  const dryRun = argv.includes("--dry-run");
  const report = get("--report") ?? `eval/reports/${runner}${model ? "-" + model.replace(/[^\w.-]/g, "_") : ""}.json`;
  const compare = get("--compare");
  const fixtures = get("--fixtures");
  const resume = get("--resume");
  return { runner: runner as RunnerName, model, effort, draws, baseline, report, dryRun, compare, fixtures, resume };
}

async function loadFixtures(glob: string | null): Promise<FixtureSpec[]> {
  const dirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => (glob ? new RegExp(glob).test(name) : true))
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

async function runOne(
  spec: FixtureSpec,
  runner: RunnerName,
  model: string | null,
  effort: string | null,
  dryRun: boolean
): Promise<DrawResult> {
  const loaded = loadFixture(spec);
  const start = Date.now();
  let result: ReviewResult | null = null;
  let error: string | undefined;
  try {
    if (dryRun) {
      error = "dry-run";
    } else {
      result = await review(loaded.bundle, { runner, model: model ?? undefined, reasoningEffort: effort ?? undefined });
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    loaded.cleanup();
  }
  const durationMs = Date.now() - start;
  return {
    fixtureId: spec.id,
    draw: 0,
    score: score(result, spec.expected, spec.id, error),
    durationMs,
  };
}

function aggregate(results: readonly DrawResult[], specs: readonly FixtureSpec[]): Aggregates {
  const kindByFixture = new Map(specs.map((s) => [s.id, s.kind]));
  const positiveResults = results.filter((r) => kindByFixture.get(r.fixtureId) === "positive");
  const negativeResults = results.filter((r) => kindByFixture.get(r.fixtureId) === "negative");
  const recall = positiveResults.length ? positiveResults.filter((r) => r.score.recall).length / positiveResults.length : 0;
  const falsePositiveRate = negativeResults.length
    ? negativeResults.filter((r) => r.score.falsePositive).length / negativeResults.length
    : 0;
  const invalidJsonRate = results.filter((r) => !r.score.formatOk).length / results.length;
  const verdictMatchRate = results.filter((r) => r.score.verdictMatch).length / results.length;
  const lineAnchorValidRate = results.filter((r) => r.score.lineAnchorValid).length / results.length;
  const meanDurationMs = results.reduce((sum, r) => sum + r.durationMs, 0) / (results.length || 1);
  const recallByFixture: Record<string, number> = {};
  for (const id of new Set(results.map((r) => r.fixtureId))) {
    const draws = results.filter((r) => r.fixtureId === id);
    recallByFixture[id] = draws.filter((r) => r.score.recall).length / draws.length;
  }
  return {
    recall,
    falsePositiveRate,
    invalidJsonRate,
    verdictMatchRate,
    lineAnchorValidRate,
    meanDurationMs,
    recallByFixture,
  };
}

function writeReport(args: RunArgs, results: readonly DrawResult[], specs: readonly FixtureSpec[]): Report {
  const report: Report = {
    promptHash: promptHash(),
    runner: args.runner,
    model: args.model,
    effort: args.effort,
    draws: args.draws,
    createdAt: new Date().toISOString(),
    baseline: args.baseline,
    results,
    aggregates: aggregate(results, specs),
  };
  mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
  writeFileSync(args.report, JSON.stringify(report, null, 2));
  return report;
}

function compare(baselinePath: string, candidate: Report): void {
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Report;
  if (baseline.promptHash !== candidate.promptHash) {
    throw new Error(
      `prompt hash mismatch: baseline ${baseline.promptHash} vs candidate ${candidate.promptHash}. Re-run baseline after prompt changes.`
    );
  }
  const b = baseline.aggregates;
  const c = candidate.aggregates;
  const delta = (x: number, y: number) => (y - x);
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  const lines = [
    `compare: ${candidate.runner}${candidate.model ? "/" + candidate.model : ""}${candidate.effort ? ` @${candidate.effort}` : ""} vs baseline ${baseline.runner}`,
    `prompt-hash: ${candidate.promptHash} (matched)`,
    `  recall:                ${pct(c.recall)} (baseline ${pct(b.recall)}, Δ ${pct(delta(b.recall, c.recall))})`,
    `  falsePositiveRate:     ${pct(c.falsePositiveRate)} (baseline ${pct(b.falsePositiveRate)}, Δ ${pct(delta(b.falsePositiveRate, c.falsePositiveRate))})`,
    `  invalidJsonRate:       ${pct(c.invalidJsonRate)} (baseline ${pct(b.invalidJsonRate)}, Δ ${pct(delta(b.invalidJsonRate, c.invalidJsonRate))})`,
    `  verdictMatchRate:      ${pct(c.verdictMatchRate)} (baseline ${pct(b.verdictMatchRate)}, Δ ${pct(delta(b.verdictMatchRate, c.verdictMatchRate))})`,
    `  lineAnchorValidRate:   ${pct(c.lineAnchorValidRate)} (baseline ${pct(b.lineAnchorValidRate)}, Δ ${pct(delta(b.lineAnchorValidRate, c.lineAnchorValidRate))})`,
    `  meanDurationMs:        ${c.meanDurationMs.toFixed(0)} (baseline ${b.meanDurationMs.toFixed(0)})`,
  ];
  process.stdout.write(lines.join("\n") + "\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.compare) {
    const specs = await loadFixtures(args.fixtures);
    const results: DrawResult[] = [];
    for (const spec of specs) {
      for (let draw = 0; draw < args.draws; draw++) {
        results.push(await runOne(spec, args.runner, args.model, args.effort, args.dryRun));
      }
    }
    const report = writeReport(args, results, specs);
    compare(args.compare, report);
    return;
  }

  const specs = await loadFixtures(args.fixtures);
  if (specs.length === 0) {
    process.stderr.write("no fixtures found\n");
    process.exit(1);
  }
  process.stderr.write(`prompt-hash: ${promptHash()}\n`);
  process.stderr.write(`fixtures: ${specs.length} | runner: ${args.runner} | model: ${args.model ?? "(default)"}${args.effort ? ` | effort: ${args.effort}` : ""} | draws: ${args.draws}${args.dryRun ? " | dry-run" : ""}\n`);

  const results: DrawResult[] = [];
  let skipped = 0;
  if (args.resume) {
    try {
      const existing = JSON.parse(readFileSync(args.resume, "utf8")) as Report;
      const byFixture = new Map<string, DrawResult[]>();
      for (const r of existing.results) {
        const arr = byFixture.get(r.fixtureId) ?? [];
        arr.push(r);
        byFixture.set(r.fixtureId, arr);
      }
      for (const spec of specs) {
        const draws = byFixture.get(spec.id) ?? [];
        const good = draws.filter((d) => d.score.formatOk);
        if (good.length >= args.draws) {
          results.push(...good.slice(0, args.draws));
          skipped++;
        }
      }
      process.stderr.write(`resume: reused ${skipped} fixture(s) with ${args.draws} good draws, re-running the rest\n`);
    } catch (err) {
      process.stderr.write(`resume: could not load ${args.resume} (${err instanceof Error ? err.message : err}), starting fresh\n`);
    }
  }
  const doneIds = new Set(results.map((r) => r.fixtureId));
  for (const spec of specs) {
    if (doneIds.has(spec.id)) continue;
    for (let draw = 0; draw < args.draws; draw++) {
      process.stderr.write(`  [${spec.id}] draw ${draw + 1}/${args.draws} ... `);
      const r = await runOne(spec, args.runner, args.model, args.effort, args.dryRun);
      results.push({ ...r, draw });
      process.stderr.write(`${r.score.formatOk ? "ok" : "FAIL"} (${r.durationMs}ms)\n`);
      writeReport(args, results, specs);
    }
  }

  const report = writeReport(args, results, specs);
  process.stderr.write(`report: ${args.report}\n`);
  process.stdout.write(JSON.stringify({ promptHash: report.promptHash, aggregates: report.aggregates }, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
