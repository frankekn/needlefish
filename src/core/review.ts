import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { runCodex, extractJson } from "../shared/codex";
import {
  normalizeReview,
  type Bundle,
  type RawReview,
  type ReviewResult,
} from "../shared/schema";
import { deriveVerdict } from "./verdict";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "..", "..", "prompts");

function loadPrompt(name: string): string {
  return readFileSync(path.join(PROMPTS_DIR, name), "utf8");
}

export async function review(
  bundle: Bundle
): Promise<ReviewResult> {
  const reviewPrompt = loadPrompt("review.md").replace(
    "{{BUNDLE}}",
    () => JSON.stringify(bundle, null, 2)
  );

  const rawCandidate = runCodex(reviewPrompt, { repoPath: bundle.repoPath });
  const candidate = normalizeReview(extractJson(rawCandidate));

  const criticPrompt = loadPrompt("critic.md")
    .replace("{{FINDINGS}}", () => JSON.stringify(candidate, null, 2))
    .replace("{{PATCH}}", () => bundle.patch);
  const rawPruned = runCodex(criticPrompt, { repoPath: bundle.repoPath });
  const pruned: RawReview = normalizeReview(extractJson(rawPruned));
  if (!pruned.summary && pruned.findings.length === 0 && pruned.checked.length === 0) {
    throw new Error(
      "review produced no usable output (empty summary, findings, and checks)"
    );
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
