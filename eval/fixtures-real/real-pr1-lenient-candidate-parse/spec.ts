// Real-PR fixture (curated from review-thread evidence, NOT the code diff).
// mustFind patterns below were derived from the reviewer's own wording in the
// linked PR thread per eval/fixtures-real/README.md step 4 -- never from
// reverse-engineering the diff. Patterns commander-reviewed 2026-07-10.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr1-lenient-candidate-parse",
  kind: "positive",
  holdout: true,
  tier: 3,
  defectClass: "lenient-candidate-parse-drops-real-finding",
  description:
    "Real PR (rejected in review): the first (candidate) Codex pass is parsed with strict=false, so normalizeReview silently filters out any malformed finding instead of failing; a real P1/P2 finding with one malformed required field is silently dropped to an empty findings list before the critic ever sees it. Source: https://github.com/frankekn/needlefish/pull/1#discussion_r3481174298.",
  baseFiles: {
    "src/core/review.ts": "import { readFileSync } from \"node:fs\";\nimport { fileURLToPath } from \"node:url\";\nimport path from \"node:path\";\nimport { runCodex, extractJson } from \"../shared/codex\";\nimport {\n  normalizeReview,\n  type Bundle,\n  type RawReview,\n  type ReviewResult,\n} from \"../shared/schema\";\nimport { deriveVerdict } from \"./verdict\";\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst PROMPTS_DIR = path.resolve(__dirname, \"..\", \"..\", \"prompts\");\n\nfunction loadPrompt(name: string): string {\n  return readFileSync(path.join(PROMPTS_DIR, name), \"utf8\");\n}\n\nexport async function review(\n  bundle: Bundle\n): Promise<ReviewResult> {\n  const reviewPrompt = loadPrompt(\"review.md\").replace(\n    \"{{BUNDLE}}\",\n    () => JSON.stringify(bundle, null, 2)\n  );\n\n  const rawCandidate = runCodex(reviewPrompt, { repoPath: bundle.repoPath });\n  const candidate = normalizeReview(extractJson(rawCandidate));\n  if (!candidate.summary || candidate.checked.length === 0) {\n    throw new Error(\"review produced no summary or checked list (likely malformed output)\");\n  }\n\n  const criticPrompt = loadPrompt(\"critic.md\")\n    .replace(\"{{FINDINGS}}\", () => JSON.stringify(candidate, null, 2))\n    .replace(\"{{PATCH}}\", () => bundle.patch);\n  const rawPruned = runCodex(criticPrompt, { repoPath: bundle.repoPath });\n  const pruned: RawReview = normalizeReview(extractJson(rawPruned));\n  if (!pruned.summary || pruned.checked.length === 0) {\n    throw new Error(\"critic produced no summary or checked list (likely malformed output)\");\n  }\n\n  const verdict = deriveVerdict(pruned.findings, pruned.residual_risks);\n\n  return {\n    verdict,\n    summary: pruned.summary || candidate.summary,\n    findings: pruned.findings,\n    checked: pruned.checked.length ? pruned.checked : candidate.checked,\n    residualRisks: pruned.residual_risks,\n    baseSha: bundle.baseSha,\n    headSha: bundle.headSha,\n  };\n}\n",
  },
  headFiles: {
    "src/core/review.ts": "import { readFileSync } from \"node:fs\";\nimport { fileURLToPath } from \"node:url\";\nimport path from \"node:path\";\nimport { runCodex, extractJson } from \"../shared/codex\";\nimport {\n  normalizeReview,\n  type Bundle,\n  type RawReview,\n  type ReviewResult,\n} from \"../shared/schema\";\nimport { deriveVerdict } from \"./verdict\";\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst PROMPTS_DIR = path.resolve(__dirname, \"..\", \"..\", \"prompts\");\n\nfunction loadPrompt(name: string): string {\n  return readFileSync(path.join(PROMPTS_DIR, name), \"utf8\");\n}\n\nexport async function review(\n  bundle: Bundle\n): Promise<ReviewResult> {\n  const reviewPrompt = loadPrompt(\"review.md\").replace(\n    \"{{BUNDLE}}\",\n    () => JSON.stringify(bundle, null, 2)\n  );\n\n  const rawCandidate = runCodex(reviewPrompt, { repoPath: bundle.repoPath });\n  const candidate = normalizeReview(extractJson(rawCandidate), false);\n  if (!candidate.summary || candidate.checked.length === 0) {\n    throw new Error(\"review produced no summary or checked list (likely malformed output)\");\n  }\n\n  const criticPrompt = loadPrompt(\"critic.md\")\n    .replace(\"{{FINDINGS}}\", () => JSON.stringify(candidate, null, 2))\n    .replace(\"{{PATCH}}\", () => bundle.patch);\n  const rawPruned = runCodex(criticPrompt, { repoPath: bundle.repoPath });\n  const pruned: RawReview = normalizeReview(extractJson(rawPruned));\n  if (!pruned.summary || pruned.checked.length === 0) {\n    throw new Error(\"critic produced no summary or checked list (likely malformed output)\");\n  }\n\n  const verdict = deriveVerdict(pruned.findings, pruned.residual_risks);\n\n  return {\n    verdict,\n    summary: pruned.summary || candidate.summary,\n    findings: pruned.findings,\n    checked: pruned.checked.length ? pruned.checked : candidate.checked,\n    residualRisks: pruned.residual_risks,\n    baseSha: bundle.baseSha,\n    headSha: bundle.headSha,\n  };\n}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "strict\\s*[:=]\\s*false|lenient|silently.{0,20}(filter|drop)|malformed.{0,20}finding|candidate.{0,20}(pass|parse)" },
    ],
    anchorFile: "src/core/review.ts",
  },
  provenance: { repo: "frankekn/needlefish", pr: 1, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/1#discussion_r3481174298", fixSha: "49350eb8fb92b6d429235b325bf4e44b908fc216" },
};

export default spec;
