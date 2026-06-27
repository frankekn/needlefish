import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runCodex, extractJson } from "../shared/codex";
import {
  normalizeReview,
  normalizeMap,
  type Bundle,
  type Finding,
  type Hotspot,
  type RawReview,
  type ResidualRisk,
  type ReviewResult,
  type Severity,
} from "../shared/schema";
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

function isLarge(bundle: Bundle): boolean {
  return bundle.patch.length > LARGE_PATCH_CHARS || bundle.changedFiles.length > LARGE_FILE_COUNT;
}

function dedup(findings: Finding[]): Finding[] {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}|${f.lineStart}|${f.category}|${norm(f.title).slice(0, 60)}|${norm(f.whyItBreaks).slice(0, 80)}`;
    const prev = out.get(key);
    if (!prev || SEV_RANK[f.severity] < SEV_RANK[prev.severity]) out.set(key, f);
  }
  return [...out.values()];
}

function sortByRisk(hotspots: Hotspot[]): Hotspot[] {
  const rank = { high: 0, med: 1, low: 2 } as const;
  return [...hotspots].sort((a, b) => rank[a.risk] - rank[b.risk]);
}

// Small PR: stuff the full diff into one review call (current behavior).
async function reviewSmall(bundle: Bundle): Promise<ReviewResult> {
  const reviewPrompt = loadPrompt("review.md").replace(
    "{{BUNDLE}}",
    () => JSON.stringify(bundle, null, 2)
  );
  const candidate = normalizeReview(extractJson(runCodex(reviewPrompt, { repoPath: bundle.repoPath })));
  if (!candidate.summary || candidate.checked.length === 0) {
    throw new Error("review produced no summary or checked list (likely malformed output)");
  }
  const criticPrompt = loadPrompt("critic.md")
    .replace("{{FINDINGS}}", () => JSON.stringify(candidate, null, 2))
    .replace("{{PATCH}}", () => bundle.patch)
    .replace("{{BASE}}", bundle.baseSha)
    .replace("{{HEAD}}", bundle.headSha);
  const pruned: RawReview = normalizeReview(extractJson(runCodex(criticPrompt, { repoPath: bundle.repoPath })));
  if (!pruned.summary || pruned.checked.length === 0) {
    throw new Error("critic produced no summary or checked list (likely malformed output)");
  }
  const verdict = deriveVerdict(pruned.findings, pruned.residual_risks);
  return {
    verdict,
    summary: pruned.summary || candidate.summary,
    findings: pruned.findings,
    checked: pruned.checked.length ? pruned.checked : candidate.checked,
    residualRisks: pruned.residual_risks,
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
  };
}

// Large PR: map (blast-radius survey, no diff text) -> deep per hotspot -> merge -> critic.
async function reviewLarge(bundle: Bundle): Promise<ReviewResult> {
  const mapBundle = {
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
    patchStat: bundle.patchStat,
    changedFiles: bundle.changedFiles,
    agentsMd: bundle.agentsMd,
    focus: bundle.focus,
    deep: bundle.deep,
  };
  const mapPrompt = loadPrompt("map.md").replace("{{BUNDLE}}", () => JSON.stringify(mapBundle, null, 2));
  const mapResult = normalizeMap(extractJson(runCodex(mapPrompt, { repoPath: bundle.repoPath })));
  if (mapResult.hotspots.length === 0) {
    throw new Error("map pass produced no hotspots");
  }

  const hotspots = sortByRisk(mapResult.hotspots).slice(0, MAX_HOTSPOTS);

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

  const agents = bundle.agentsMd ?? "(no AGENTS.md)";
  let all: Finding[] = [];
  const checked: string[] = [];
  const residuals: ResidualRisk[] = [];
  for (const h of hotspots) {
    const deepPrompt = loadPrompt("deep.md")
      .replace("{{AGENTS}}", () => agents)
      .replace("{{HOTSPOT}}", () => JSON.stringify(h, null, 2))
      .replace("{{FOCUS}}", bundle.focus ?? "(none)")
      .replace("{{BASE}}", bundle.baseSha)
      .replace("{{HEAD}}", bundle.headSha);
    let res: RawReview;
    try {
      res = normalizeReview(extractJson(runCodex(deepPrompt, { repoPath: bundle.repoPath })));
      checked.push(`[${h.name}] ${res.summary || "(no summary)"}`);
      all = all.concat(res.findings);
      residuals.push(...res.residual_risks);
    } catch (e) {
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
  const criticPrompt = loadPrompt("critic.md")
    .replace("{{FINDINGS}}", () => JSON.stringify(candidateMerged, null, 2))
    .replace("{{PATCH}}", () => bundle.patchStat || "(see git diff --stat; repo at HEAD)")
    .replace("{{BASE}}", bundle.baseSha)
    .replace("{{HEAD}}", bundle.headSha);
  const pruned: RawReview = normalizeReview(extractJson(runCodex(criticPrompt, { repoPath: bundle.repoPath })));
  if (!pruned.summary || pruned.checked.length === 0) {
    throw new Error("critic produced no summary or checked list (likely malformed output)");
  }
  const verdict = deriveVerdict(pruned.findings, pruned.residual_risks);
  return {
    verdict,
    summary: `${mapResult.summary} — ${pruned.summary}`,
    findings: pruned.findings,
    checked: pruned.checked.length ? pruned.checked : checked,
    residualRisks: pruned.residual_risks,
    baseSha: bundle.baseSha,
    headSha: bundle.headSha,
  };
}

export async function review(bundle: Bundle): Promise<ReviewResult> {
  return isLarge(bundle) ? reviewLarge(bundle) : reviewSmall(bundle);
}
