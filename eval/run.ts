import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { review } from "../src/core/review";
import { parseRunnerName, type RunnerName } from "../src/shared/runner";
import type { ReviewResult } from "../src/shared/schema";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { score } from "./shared/score";
import type {
  Aggregates,
  DrawResult,
  FixtureSpec,
  HoldoutMode,
  Report,
} from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

interface RunArgs {
  runner: RunnerName;
  model: string | null;
  effort: string | null;
  draws: number;
  concurrency: number;
  baseline: boolean;
  report: string;
  dryRun: boolean;
  compare: string | null;
  fixtures: string | null;
  resume: string | null;
  holdout: HoldoutMode;
  env: Record<string, string>;
}

export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, i: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export function parseArgs(argv: readonly string[]): RunArgs {
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const runner = parseRunnerName(get("--runner") ?? "codex", "--runner");
  const model = get("--model");
  const effort = get("--effort");
  const draws = Number(get("--draws") ?? "1");
  if (!Number.isInteger(draws) || draws < 1) throw new Error("--draws must be a positive integer");
  const concurrencyIdx = argv.indexOf("--concurrency");
  let concurrency = 4;
  if (concurrencyIdx >= 0) {
    const raw = argv[concurrencyIdx + 1];
    if (raw === undefined || raw.startsWith("--")) throw new Error("--concurrency must be a positive integer");
    concurrency = Number(raw);
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("--concurrency must be a positive integer");
  }
  const baseline = argv.includes("--baseline");
  const dryRun = argv.includes("--dry-run");
  const report = get("--report") ?? `eval/reports/${runner}${model ? "-" + model.replace(/[^\w.-]/g, "_") : ""}.json`;
  const compare = get("--compare");
  const fixtures = get("--fixtures");
  const resume = get("--resume");
  const holdoutRaw = get("--holdout") ?? "include";
  if (holdoutRaw !== "include" && holdoutRaw !== "exclude" && holdoutRaw !== "only") {
    throw new Error(`--holdout must be include|exclude|only, got: ${holdoutRaw}`);
  }
  const holdout = holdoutRaw as HoldoutMode;
  const env: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== "--env") continue;
    const raw = argv[i + 1];
    if (!raw) throw new Error("--env requires KEY=VALUE");
    const eq = raw.indexOf("=");
    if (eq <= 0) throw new Error(`--env requires KEY=VALUE, got: ${raw}`);
    env[raw.slice(0, eq)] = raw.slice(eq + 1);
    i++;
  }
  return { runner, model, effort, draws, concurrency, baseline, report, dryRun, compare, fixtures, resume, holdout, env };
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

// Holdout filtering is a pure post-load step so plain runs always tell the
// full truth (include), prompt-tuning iteration can hide sealed holdouts
// (exclude), and final gates can run just the holdouts (only).
export function filterByHoldout(specs: readonly FixtureSpec[], mode: HoldoutMode): FixtureSpec[] {
  if (mode === "include") return [...specs];
  if (mode === "only") return specs.filter((s) => s.holdout === true);
  return specs.filter((s) => s.holdout !== true);
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
  const stats = result?.stats;
  const calls = stats?.length ?? 0;
  const retries = stats?.reduce((sum, s) => sum + (s.attempts - 1), 0) ?? 0;
  return {
    fixtureId: spec.id,
    draw: 0,
    score: score(result, spec.expected, spec.id, error),
    durationMs,
    calls,
    retries,
  };
}

interface DrawWork {
  readonly spec: FixtureSpec;
  readonly draw: number;
}

function buildWorkList(specs: readonly FixtureSpec[], draws: number): DrawWork[] {
  const work: DrawWork[] = [];
  for (const spec of specs) {
    for (let draw = 0; draw < draws; draw++) {
      work.push({ spec, draw });
    }
  }
  return work;
}

function completedResults(slots: readonly (DrawResult | null)[]): DrawResult[] {
  return slots.filter((r): r is DrawResult => r !== null);
}

function resumeSlots(
  args: RunArgs,
  specs: readonly FixtureSpec[],
  work: readonly DrawWork[]
): { slots: (DrawResult | null)[]; skipped: number } {
  const slots: (DrawResult | null)[] = new Array(work.length).fill(null);
  let skipped = 0;
  if (!args.resume) return { slots, skipped };
  try {
    const existing = JSON.parse(readFileSync(args.resume, "utf8")) as Report;
    const byFixture = new Map<string, DrawResult[]>();
    for (const r of existing.results) {
      const arr = byFixture.get(r.fixtureId) ?? [];
      arr.push(r);
      byFixture.set(r.fixtureId, arr);
    }
    const doneFixtures = new Set<string>();
    for (const spec of specs) {
      const draws = byFixture.get(spec.id) ?? [];
      const good = draws.filter((d) => d.score.formatOk);
      if (good.length >= args.draws) {
        doneFixtures.add(spec.id);
        skipped++;
      }
    }
    for (let i = 0; i < work.length; i++) {
      const { spec, draw } = work[i];
      if (!doneFixtures.has(spec.id)) continue;
      const good = (byFixture.get(spec.id) ?? []).filter((d) => d.score.formatOk);
      slots[i] = { ...good[draw], draw, calls: good[draw].calls ?? 0, retries: good[draw].retries ?? 0 };
    }
    process.stderr.write(`resume: reused ${skipped} fixture(s) with ${args.draws} good draws, re-running the rest\n`);
  } catch (err) {
    process.stderr.write(`resume: could not load ${args.resume} (${err instanceof Error ? err.message : err}), starting fresh\n`);
  }
  return { slots, skipped };
}

async function runWork(
  args: RunArgs,
  work: readonly DrawWork[],
  slots: (DrawResult | null)[],
  onDrawComplete?: (results: readonly DrawResult[]) => void
): Promise<DrawResult[]> {
  const pending = work.map((_, i) => i).filter((i) => slots[i] === null);
  await mapLimit(pending, args.concurrency, async (idx) => {
    const { spec, draw } = work[idx];
    const r = await runOne(spec, args.runner, args.model, args.effort, args.dryRun);
    const result = { ...r, draw };
    slots[idx] = result;
    process.stderr.write(
      `  [${spec.id}] draw ${draw + 1}/${args.draws} ${r.score.formatOk ? "ok" : "FAIL"} (${r.durationMs}ms)\n`
    );
    onDrawComplete?.(completedResults(slots));
    return result;
  });
  return slots.map((r, i) => {
    if (r === null) throw new Error(`missing draw result for ${work[i].spec.id} draw ${work[i].draw}`);
    return r;
  });
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
  const criticPruneErrorRate = positiveResults.length
    ? positiveResults.filter((r) => r.score.criticPruneError).length / positiveResults.length
    : 0;
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
    criticPruneErrorRate,
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
    holdout: args.holdout,
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
  // Eval runs always enable the critic prune-error trace. Applied once here
  // (not per-draw) alongside user --env overrides, and restored in finally.
  // A user `--env NEEDLEFISH_EVAL_TRACE=...` wins over the default.
  const envDefaults: Record<string, string> = { NEEDLEFISH_EVAL_TRACE: "1" };
  const envPrevious = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries({ ...envDefaults, ...args.env })) {
    envPrevious.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    const loaded = await loadFixtures(args.fixtures);
    const specs = filterByHoldout(loaded, args.holdout);
    const work = buildWorkList(specs, args.draws);

    if (args.compare) {
      const slots: (DrawResult | null)[] = new Array(work.length).fill(null);
      const results = await runWork(args, work, slots);
      const report = writeReport(args, results, specs);
      compare(args.compare, report);
      return;
    }
    if (specs.length === 0) {
      process.stderr.write("no fixtures found\n");
      process.exit(1);
    }
    process.stderr.write(`prompt-hash: ${promptHash()}\n`);
    process.stderr.write(
      `fixtures: ${specs.length} | runner: ${args.runner} | model: ${args.model ?? "(default)"}${args.effort ? ` | effort: ${args.effort}` : ""} | draws: ${args.draws} | concurrency: ${args.concurrency} | holdout: ${args.holdout}${args.dryRun ? " | dry-run" : ""}\n`
    );

    const { slots } = resumeSlots(args, specs, work);
    const onDrawComplete = args.resume
      ? (partial: readonly DrawResult[]) => writeReport(args, partial, specs)
      : undefined;
    const results = await runWork(args, work, slots, onDrawComplete);

    const report = writeReport(args, results, specs);
    process.stderr.write(`report: ${args.report}\n`);
    process.stdout.write(JSON.stringify({ promptHash: report.promptHash, aggregates: report.aggregates }, null, 2) + "\n");
  } finally {
    for (const [key, value] of envPrevious) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
