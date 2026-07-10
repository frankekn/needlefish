// Real-PR fixture (curated from review-thread evidence, NOT the code diff).
// mustFind patterns below were derived from the reviewer's own wording in the
// linked PR thread per eval/fixtures-real/README.md step 4 -- never from
// reverse-engineering the diff. Patterns commander-reviewed 2026-07-10.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr1-dollar-token-corruption",
  kind: "positive",
  tier: 2,
  defectClass: "string-replace-dollar-token-corruption",
  description:
    "Real PR (rejected in review): String.replace is called with the JSON bundle / raw patch text as the plain replacement string; $-sequences such as $& inside that text are treated as regex substitution tokens, so any reviewed diff containing them is silently rewritten before Codex sees it, corrupting the prompt payload and letting Needlefish review corrupted code. Source: https://github.com/frankekn/needlefish/pull/1#discussion_r3480470293.",
  baseFiles: {
    "src/core/review.ts": "import { readFileSync } from \"node:fs\";\nimport { fileURLToPath } from \"node:url\";\nimport path from \"node:path\";\nimport { runCodex, extractJson } from \"../shared/codex\";\nimport {\n  normalizeReview,\n  type Bundle,\n  type RawReview,\n  type ReviewResult,\n} from \"../shared/schema\";\nimport { deriveVerdict } from \"./verdict\";\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst PROMPTS_DIR = path.resolve(__dirname, \"..\", \"..\", \"prompts\");\n\nfunction loadPrompt(name: string): string {\n  return readFileSync(path.join(PROMPTS_DIR, name), \"utf8\");\n}\n\nexport async function review(\n  bundle: Bundle\n): Promise<ReviewResult> {\n  const reviewPrompt = loadPrompt(\"review.md\").replace(\n    \"{{BUNDLE}}\",\n    () => JSON.stringify(bundle, null, 2)\n  );\n\n  const rawCandidate = runCodex(reviewPrompt, { repoPath: bundle.repoPath });\n  const candidate = normalizeReview(extractJson(rawCandidate));\n\n  const criticPrompt = loadPrompt(\"critic.md\")\n    .replace(\"{{FINDINGS}}\", () => JSON.stringify(candidate, null, 2))\n    .replace(\"{{PATCH}}\", () => bundle.patch);\n  const rawPruned = runCodex(criticPrompt, { repoPath: bundle.repoPath });\n  const pruned: RawReview = normalizeReview(extractJson(rawPruned));\n\n  const verdict = deriveVerdict(pruned.findings, pruned.residual_risks);\n\n  return {\n    verdict,\n    summary: pruned.summary || candidate.summary,\n    findings: pruned.findings,\n    checked: pruned.checked.length ? pruned.checked : candidate.checked,\n    residualRisks: pruned.residual_risks,\n    baseSha: bundle.baseSha,\n    headSha: bundle.headSha,\n  };\n}\n",
  },
  headFiles: {
    "src/core/review.ts": "import { readFileSync } from \"node:fs\";\nimport { fileURLToPath } from \"node:url\";\nimport path from \"node:path\";\nimport { runCodex, extractJson } from \"../shared/codex\";\nimport {\n  normalizeReview,\n  type Bundle,\n  type RawReview,\n  type ReviewResult,\n} from \"../shared/schema\";\nimport { deriveVerdict } from \"./verdict\";\n\nconst __dirname = path.dirname(fileURLToPath(import.meta.url));\nconst PROMPTS_DIR = path.resolve(__dirname, \"..\", \"..\", \"prompts\");\n\nfunction loadPrompt(name: string): string {\n  return readFileSync(path.join(PROMPTS_DIR, name), \"utf8\");\n}\n\nexport async function review(\n  bundle: Bundle\n): Promise<ReviewResult> {\n  const reviewPrompt = loadPrompt(\"review.md\").replace(\n    \"{{BUNDLE}}\",\n    JSON.stringify(bundle, null, 2)\n  );\n\n  const rawCandidate = runCodex(reviewPrompt, { repoPath: bundle.repoPath });\n  const candidate = normalizeReview(extractJson(rawCandidate));\n\n  const criticPrompt = loadPrompt(\"critic.md\")\n    .replace(\"{{FINDINGS}}\", JSON.stringify(candidate, null, 2))\n    .replace(\"{{PATCH}}\", bundle.patch);\n  const rawPruned = runCodex(criticPrompt, { repoPath: bundle.repoPath });\n  const pruned: RawReview = normalizeReview(extractJson(rawPruned));\n\n  const verdict = deriveVerdict(pruned.findings, pruned.residual_risks);\n\n  return {\n    verdict,\n    summary: pruned.summary || candidate.summary,\n    findings: pruned.findings,\n    checked: pruned.checked.length ? pruned.checked : candidate.checked,\n    residualRisks: pruned.residual_risks,\n    baseSha: bundle.baseSha,\n    headSha: bundle.headSha,\n  };\n}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "\\$&|dollar|substitution.{0,20}token|replace.{0,24}(string|callback|function)|corrupt.{0,20}(payload|prompt|diff)" },
    ],
    anchorFile: "src/core/review.ts",
  },
  provenance: { repo: "frankekn/needlefish", pr: 1, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/1#discussion_r3480470293", fixSha: "b5a11d3952e9f2ef42eb7382128e06fdccd44f26" },
};

export default spec;
