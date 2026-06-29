import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runCodex, extractJson, isRunnerSafetyError, type CodexOptions } from "../shared/codex";
import type { RunnerOptions } from "../shared/runner";
import {
  type Bundle,
  type Finding,
  type Hotspot,
  type RawReview,
  type ResidualRisk,
  type ReviewResult,
  type Severity,
} from "../shared/schema";
import { normalizeMap, normalizeReview } from "../shared/normalize";
import { deriveVerdict } from "./verdict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "..", "..", "prompts");

function loadPrompt(name: string): string {
  return readFileSync(path.join(PROMPTS_DIR, name), "utf8");
}

const LARGE_PATCH_CHARS = 30000;
const LARGE_FILE_COUNT = 10;
const MAX_HOTSPOTS = 6;
const SEV_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

interface ReviewRun {
  readonly bundle: Bundle;
  readonly runnerOptions: RunnerOptions;
}

function isLarge(bundle: Bundle): boolean {
  return bundle.patch.length > LARGE_PATCH_CHARS || bundle.changedFiles.length > LARGE_FILE_COUNT;
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

function codexOptions(run: ReviewRun): CodexOptions {
  return { repoPath: run.bundle.repoPath, targetHeadSha: run.bundle.headSha, ...run.runnerOptions };
}

async function runReviewPrompt(prompt: string, run: ReviewRun): Promise<RawReview> {
  return normalizeReview(extractJson(await runCodex(prompt, codexOptions(run))));
}

function assertUsableReview(review: RawReview, label: string): void {
  if (!review.summary || review.checked.length === 0) {
    throw new Error(`${label} produced no summary or checked list (likely malformed output)`);
  }
}

async function runCritic(candidate: RawReview, patchText: string, run: ReviewRun): Promise<RawReview> {
  const { bundle } = run;
  const criticPrompt = loadPrompt("critic.md")
    .replace("{{FINDINGS}}", () => JSON.stringify(candidate, null, 2))
    .replace("{{PATCH}}", () => patchText)
    .replace("{{BASE}}", bundle.baseSha)
    .replace("{{HEAD}}", bundle.headSha);
  const pruned = await runReviewPrompt(criticPrompt, run);
  assertUsableReview(pruned, "critic");
  return pruned;
}

function toReviewResult(raw: RawReview, run: ReviewRun, summary = raw.summary): ReviewResult {
  const { bundle } = run;
  const verdict = deriveVerdict(raw.findings, raw.residual_risks);
  return {
    verdict,
    summary,
    findings: raw.findings,
    checked: raw.checked,
    residualRisks: raw.residual_risks,
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
  };
}

// Small PR: stuff the full diff into one review call (current behavior).
async function reviewSmall(run: ReviewRun): Promise<ReviewResult> {
  const { bundle } = run;
  const reviewPrompt = loadPrompt("review.md").replace(
    "{{BUNDLE}}",
    () => JSON.stringify(bundle, null, 2)
  );
  const candidate = await runReviewPrompt(reviewPrompt, run);
  assertUsableReview(candidate, "review");
  return toReviewResult(await runCritic(candidate, bundle.patch, run), run);
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
  const mapResult = normalizeMap(extractJson(await runCodex(mapPrompt, codexOptions(run))));
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
  let all: Finding[] = [];
  const checked: string[] = [];
  const residuals: ResidualRisk[] = [];
  for (const h of hotspots) {
    const deepPrompt = loadPrompt("deep.md")
      .replace("{{AGENTS}}", () => agents)
      .replace("{{PR_META}}", () => JSON.stringify(bundle.prMeta, null, 2))
      .replace("{{HOTSPOT}}", () => JSON.stringify(h, null, 2))
      .replace("{{FOCUS}}", bundle.focus ?? "(none)")
      .replace("{{BASE}}", bundle.baseSha)
      .replace("{{HEAD}}", bundle.headSha);
    let res: RawReview;
    try {
      res = normalizeReview(extractJson(await runCodex(deepPrompt, codexOptions(run))));
      checked.push(`[${h.name}] ${res.summary || "(no summary)"}`);
      checked.push(...res.checked);
      all = all.concat(res.findings);
      residuals.push(...res.residual_risks);
    } catch (e) {
      if (isRunnerSafetyError(e)) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      checked.push(`[${h.name}] DEEP PASS FAILED: ${msg.slice(0, 200)}`);
      residuals.push({ text: `deep review of "${h.name}" failed (${msg.slice(0, 150)}); ${h.files.length} file(s) not deep-reviewed`, blocks: true });
    }
  }

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
  return toReviewResult(pruned, run, `${mapResult.summary} — ${pruned.summary}`);
}

export async function review(
  bundle: Bundle,
  runnerOptions: RunnerOptions = {}
): Promise<ReviewResult> {
  const run = { bundle, runnerOptions };
  return bundle.deep || isLarge(bundle) ? reviewLarge(run) : reviewSmall(run);
}
