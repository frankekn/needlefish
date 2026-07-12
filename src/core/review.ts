import { runCodex, extractJson, isRunnerSafetyError, type CodexOptions } from "../shared/codex.js";
import { parsePositiveInteger, type RunnerOptions, type RunStat } from "../shared/runner.js";
import {
  REVIEW_RESULT_SCHEMA_VERSION,
  type Bundle,
  type Finding,
  type Hotspot,
  type RawReview,
  type ResidualRisk,
  type ReviewResult,
  type Severity,
} from "../shared/schema.js";
import { normalizeMap, normalizeReview } from "../shared/normalize.js";
import { deriveVerdict } from "./verdict.js";
import { loadPrompt } from "./prompts.js";

const LARGE_PATCH_CHARS = 30000;
const LARGE_FILE_COUNT = 10;
const MAX_HOTSPOTS = 6;
const DEFAULT_DEEP_CONCURRENCY = 3;
const SEV_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

interface ReviewRun {
  readonly bundle: Bundle;
  readonly runnerOptions: RunnerOptions;
  readonly stats: RunStat[];
  // Raw text of every failed parse attempt across all passes, kept even when
  // a retry later succeeds — the eval canary scan must see emit-then-clean-up
  // sequences. Mutable accumulator, same pattern as stats.
  readonly failedRawOutputs: string[];
  // Raw text of every SUCCESSFUL attempt (trace-gated collection): some pass
  // outputs are consumed but not retained in the final result (map hotspot
  // why/edges, critic-pruned residual text) — the canary scan needs the full
  // transcript, not just what survived into ReviewResult.
  readonly rawOutputs: string[];
  readonly startedAt: number;
}

function envPositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return parsePositiveInteger(raw, name);
}

function deepConcurrency(): number {
  return envPositiveInt("NEEDLEFISH_DEEP_CONCURRENCY", DEFAULT_DEEP_CONCURRENCY);
}

// Eval-only: when set, ReviewResult carries candidateFindings (the pre-critic
// finding list) so the eval scorer can detect critic prune-errors. Zero cost
// when unset — callers still pass the candidate list (a reference), but it is
// only attached to the result here when the flag is on.
function evalTraceOn(): boolean {
  const raw = process.env.NEEDLEFISH_EVAL_TRACE;
  return raw !== undefined && raw !== "";
}

// Worker pool over a shared index; results land at their item's index so
// output order never depends on completion order.
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function isLarge(bundle: Bundle): boolean {
  return (
    bundle.patch.length > envPositiveInt("NEEDLEFISH_LARGE_PATCH_CHARS", LARGE_PATCH_CHARS) ||
    bundle.changedFiles.length > envPositiveInt("NEEDLEFISH_LARGE_FILE_COUNT", LARGE_FILE_COUNT)
  );
}

function changedHotspots(hotspots: readonly Hotspot[], bundle: Bundle): Hotspot[] {
  const changed = new Set(bundle.changedFiles.map((file) => file.path));
  return hotspots
    .map((hotspot) => ({
      ...hotspot,
      files: hotspot.files.filter((file) => changed.has(file)),
    }))
    .filter((hotspot) => hotspot.files.length > 0);
}

function dedup(findings: readonly Finding[]): Finding[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}|${f.lineStart}|${f.category}|${norm(f.title).slice(0, 60)}|${norm(f.whyItBreaks).slice(0, 80)}`;
    const prev = out.get(key);
    if (!prev || SEV_RANK[f.severity] < SEV_RANK[prev.severity]) out.set(key, f);
  }
  return [...out.values()];
}

function sortByRisk(hotspots: readonly Hotspot[]): Hotspot[] {
  const rank = { high: 0, med: 1, low: 2 } as const;
  return [...hotspots].sort((a, b) => rank[a.risk] - rank[b.risk]);
}

function codexOptions(run: ReviewRun, label: string): CodexOptions {
  return {
    repoPath: run.bundle.repoPath,
    targetHeadSha: run.bundle.headSha,
    ...(run.bundle.headSha === "WORKING" ? { targetPatch: run.bundle.patch } : {}),
    label,
    onStat: (stat) => run.stats.push(stat),
    // Runner-level failures (crash, nonzero exit) hand their captured stdout
    // here so it joins the same canary-scan accumulator as parse failures.
    onFailedRaw: (raw) => run.failedRawOutputs.push(raw),
    ...run.runnerOptions,
  };
}

// Ride the run-wide failed attempts along on the error (message unchanged):
// the eval harness scans them for the bait canary — neither invalid output
// nor a cleaner retry is an escape hatch from detection. The snapshot is
// run-level, not call-local, so a contaminated attempt from an EARLIER pass
// whose retry succeeded still reaches the scan when a later pass rejects.
function attachRunRaws(err: unknown, run: ReviewRun): void {
  if (err instanceof Error && run.failedRawOutputs.length > 0) {
    (err as Error & { rawOutputs?: readonly string[] }).rawOutputs = [
      ...run.failedRawOutputs,
    ];
  }
}

// One retry on malformed output: re-ask the model, never re-parse the same
// text. Safety errors throw from runCodex itself, outside the parse try, so
// they propagate immediately without a re-ask — but still carry the run-wide
// failed raws (a crashed runner's stdout was pushed via onFailedRaw).
async function runJsonPrompt<T>(
  label: string,
  prompt: string,
  run: ReviewRun,
  parse: (raw: unknown) => T
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    let out: string;
    try {
      out = await runCodex(prompt, codexOptions(run, label));
    } catch (err) {
      attachRunRaws(err, run);
      throw err;
    }
    try {
      const parsed = parse(extractJson(out));
      if (evalTraceOn()) run.rawOutputs.push(out);
      return parsed;
    } catch (err) {
      lastErr = err;
      run.failedRawOutputs.push(out);
    }
  }
  attachRunRaws(lastErr, run);
  throw lastErr;
}

function assertUsableReview(review: RawReview, label: string): void {
  if (!review.summary || review.checked.length === 0) {
    throw new Error(`${label} produced no summary or checked list (likely malformed output)`);
  }
}

function parseUsableReview(label: string): (raw: unknown) => RawReview {
  return (raw) => {
    const review = normalizeReview(raw);
    assertUsableReview(review, label);
    return review;
  };
}

async function runCritic(candidate: RawReview, patchText: string, run: ReviewRun): Promise<RawReview> {
  const { bundle } = run;
  const criticPrompt = loadPrompt("critic.md")
    .replace("{{FINDINGS}}", () => JSON.stringify(candidate, null, 2))
    .replace("{{PATCH}}", () => patchText)
    .replace("{{BASE}}", bundle.baseSha)
    .replace("{{HEAD}}", bundle.headSha);
  return runJsonPrompt("critic", criticPrompt, run, parseUsableReview("critic"));
}

function toReviewResult(
  raw: RawReview,
  run: ReviewRun,
  summary = raw.summary,
  candidateFindings?: readonly Finding[]
): ReviewResult {
  const { bundle } = run;
  const verdict = deriveVerdict(raw.findings, raw.residual_risks);
  return {
    schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
    verdict,
    summary,
    findings: raw.findings,
    checked: raw.checked,
    residualRisks: raw.residual_risks,
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
    ...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
    ...(run.stats.length > 0 ? { stats: [...run.stats] } : {}),
    totalDurationMs: Date.now() - run.startedAt,
    ...(evalTraceOn() && candidateFindings ? { candidateFindings } : {}),
    ...(evalTraceOn() && run.failedRawOutputs.length > 0
      ? { failedRawOutputs: [...run.failedRawOutputs] }
      : {}),
    ...(evalTraceOn() && run.rawOutputs.length > 0
      ? { rawOutputs: [...run.rawOutputs] }
      : {}),
  };
}

// Small PR: one review call over the full diff. The diff goes in as raw text
// between sentinel lines — never inside the JSON bundle, where escaping
// inflates tokens and hurts the model's read of the hunks.
async function reviewSmall(run: ReviewRun): Promise<ReviewResult> {
  const { bundle } = run;
  const { patch, ...meta } = bundle;
  const reviewPrompt = loadPrompt("review.md")
    .replace("{{BUNDLE}}", () => JSON.stringify(meta, null, 2))
    .replace("{{PATCH}}", () => patch);
  const candidate = await runJsonPrompt("review", reviewPrompt, run, parseUsableReview("review"));
  return toReviewResult(await runCritic(candidate, bundle.patch, run), run, undefined, candidate.findings);
}

// Large PR: map (blast-radius survey, no diff text) -> deep per hotspot -> merge -> critic.
async function reviewLarge(run: ReviewRun): Promise<ReviewResult> {
  const { bundle } = run;
  const mapBundle = {
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
    patchStat: bundle.patchStat,
    changedFiles: bundle.changedFiles,
    agentsMd: bundle.agentsMd,
    prMeta: bundle.prMeta,
    focus: bundle.focus,
    deep: bundle.deep,
  };
  const mapPrompt = loadPrompt("map.md").replace("{{BUNDLE}}", () => JSON.stringify(mapBundle, null, 2));
  const mapResult = await runJsonPrompt("map", mapPrompt, run, normalizeMap);
  const mappedHotspots = changedHotspots(mapResult.hotspots, bundle);
  const hotspots = sortByRisk(mappedHotspots).slice(0, MAX_HOTSPOTS);

  // Coverage backstop: any changed file not in a selected hotspot goes into a tail
  // hotspot so it still gets deep-reviewed (never silently skip a changed file).
  const covered = new Set(hotspots.flatMap((h) => h.files));
  const uncovered = bundle.changedFiles.map((f) => f.path).filter((p) => !covered.has(p));
  if (uncovered.length > 0) {
    hotspots.push({
      name: "tail-coverage (files not mapped to a surface)",
      files: uncovered,
      why: "coverage backstop: these changed files were not assigned to any surface",
      risk: "low",
      edges: [],
    });
  }
  if (hotspots.length === 0) {
    throw new Error("map pass produced no changed-file hotspots");
  }

  const agents = bundle.agentsMd;
  const passes = await mapLimit(hotspots, deepConcurrency(), async (h) => {
    const deepPrompt = loadPrompt("deep.md")
      .replace("{{AGENTS}}", () => agents)
      .replace("{{PR_META}}", () => JSON.stringify(bundle.prMeta, null, 2))
      .replace("{{HOTSPOT}}", () => JSON.stringify(h, null, 2))
      .replace("{{FOCUS}}", bundle.focus ?? "(none)")
      .replace("{{BASE}}", bundle.baseSha)
      .replace("{{HEAD}}", bundle.headSha);
    try {
      const res = await runJsonPrompt(`deep:${h.name}`, deepPrompt, run, (raw) => normalizeReview(raw));
      return {
        checked: [`[${h.name}] ${res.summary || "(no summary)"}`, ...res.checked],
        findings: res.findings,
        residuals: res.residual_risks,
      };
    } catch (e) {
      if (isRunnerSafetyError(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      // Swallowed failure; its raw attempts are already in run.failedRawOutputs
      // (runJsonPrompt accumulates every failed parse there for the eval scan).
      return {
        checked: [`[${h.name}] DEEP PASS FAILED: ${msg.slice(0, 200)}`],
        findings: [] as readonly Finding[],
        residuals: [
          { text: `deep review of "${h.name}" failed (${msg.slice(0, 150)}); ${h.files.length} file(s) not deep-reviewed`, blocks: true },
        ] as readonly ResidualRisk[],
      };
    }
  });
  const all = passes.flatMap((p) => p.findings);
  const checked = passes.flatMap((p) => p.checked);
  const residuals = passes.flatMap((p) => p.residuals);

  const merged = dedup(all);
  const candidateMerged: RawReview = {
    summary: mapResult.summary,
    findings: merged,
    checked,
    residual_risks: residuals,
  };
  const pruned = await runCritic(
    candidateMerged,
    bundle.patchStat || "(see git diff --stat; repo at HEAD)",
    run
  );
  const blockingResiduals = residuals.filter((risk) => risk.blocks);
  const final = { ...pruned, residual_risks: [...pruned.residual_risks, ...blockingResiduals] };
  return toReviewResult(final, run, `${mapResult.summary} — ${pruned.summary}`, merged);
}

// Docs-only fast path: when every changed file is classified "docs" and the
// escape hatch is unset, skip all model calls and return a deterministic pass.
// classify.ts rule order already routes workflow yml to "workflow", so CI files
// can never ride this path.
function isDocsOnlyFastPath(bundle: Bundle): boolean {
  return (
    bundle.changedFiles.length > 0 &&
    bundle.changedFiles.every((f) => f.surface === "docs") &&
    !process.env.NEEDLEFISH_NO_FAST_PATH
  );
}

export async function review(
  bundle: Bundle,
  runnerOptions: RunnerOptions = {}
): Promise<ReviewResult> {
  const startedAt = Date.now();

  if (isDocsOnlyFastPath(bundle)) {
    const paths = bundle.changedFiles.map((f) => f.path).join(", ");
    return {
      schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
      verdict: "pass",
      summary: `Docs-only change (${bundle.changedFiles.length} file(s)); model review skipped.`,
      findings: [],
      checked: [`FAST_PATH docs-only files=[${paths}]`],
      residualRisks: [],
      baseSha: bundle.baseSha,
      headSha: bundle.headSha,
      ...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
      totalDurationMs: Date.now() - startedAt,
    };
  }

  const run: ReviewRun = { bundle, runnerOptions, stats: [], failedRawOutputs: [], rawOutputs: [], startedAt };
  return bundle.deep || isLarge(bundle) ? reviewLarge(run) : reviewSmall(run);
}
