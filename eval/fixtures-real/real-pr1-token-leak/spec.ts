// Real-PR fixture (curated from review-thread evidence, NOT the code diff).
// mustFind patterns below were derived from the reviewer's own wording in the
// linked PR thread per eval/fixtures-real/README.md step 4 -- never from
// reverse-engineering the diff. Patterns commander-reviewed 2026-07-10.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr1-token-leak",
  kind: "positive",
  tier: 1,
  defectClass: "subprocess-inherits-write-token",
  description:
    "Real PR (rejected in review): spawnSync for the Codex subprocess is called with no env override, so codex exec inherits the parent process's GH_TOKEN (pull-requests:write, checks:write in GitHub mode); the model-driven subprocess can call gh api directly to mutate reviews/checks, bypassing Needlefish's parser and deterministic verdict. Source: https://github.com/frankekn/needlefish/pull/1#discussion_r3481222778.",
  baseFiles: {
    "src/shared/codex.ts": "import { spawnSync } from \"node:child_process\";\nimport { mkdtempSync, readFileSync, rmSync } from \"node:fs\";\nimport os from \"node:os\";\nimport path from \"node:path\";\n\nexport interface CodexOptions {\n  repoPath: string;\n  model?: string;\n  timeoutMs?: number;\n}\n\nexport function runCodex(prompt: string, opts: CodexOptions): string {\n  const bin = process.env.CODEX_BIN ?? \"codex\";\n  const model = opts.model ?? process.env.CODEX_MODEL;\n  const timeoutMs =\n    opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 600000);\n\n  const tmp = mkdtempSync(path.join(os.tmpdir(), \"needlefish-\"));\n  const lastMsg = path.join(tmp, \"last.txt\");\n  const args = [\"exec\", \"--color\", \"never\", \"-s\", \"read-only\", \"--output-last-message\", lastMsg];\n  if (model) args.push(\"-m\", model);\n\n  const env = { ...process.env };\n  delete env.GH_TOKEN;\n  delete env.GITHUB_TOKEN;\n  delete env.GITHUB_API_TOKEN;\n\n  const res = spawnSync(bin, args, {\n    cwd: opts.repoPath,\n    env,\n    input: prompt,\n    encoding: \"utf8\",\n    timeout: timeoutMs,\n    maxBuffer: 1024 * 1024 * 64,\n  });\n\n  let out = \"\";\n  try {\n    out = readFileSync(lastMsg, \"utf8\");\n  } catch {\n    out = res.stdout ?? \"\";\n  }\n  rmSync(tmp, { recursive: true, force: true });\n\n  if (res.error) throw res.error;\n  if (res.status !== 0) {\n    throw new Error(\n      `codex exec exited ${res.status}: ${(res.stderr ?? \"\").slice(0, 2000)}`\n    );\n  }\n  return out;\n}\n\nexport function extractJson(text: string): any {\n  const fence = text.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);\n  const raw = fence ? fence[1] : text;\n  const start = raw.indexOf(\"{\");\n  const end = raw.lastIndexOf(\"}\");\n  if (start === -1 || end === -1 || end <= start) {\n    throw new Error(\"no JSON object found in codex output\");\n  }\n  return JSON.parse(raw.slice(start, end + 1));\n}\n",
  },
  headFiles: {
    "src/shared/codex.ts": "import { spawnSync } from \"node:child_process\";\nimport { mkdtempSync, readFileSync, rmSync } from \"node:fs\";\nimport os from \"node:os\";\nimport path from \"node:path\";\n\nexport interface CodexOptions {\n  repoPath: string;\n  model?: string;\n  timeoutMs?: number;\n}\n\nexport function runCodex(prompt: string, opts: CodexOptions): string {\n  const bin = process.env.CODEX_BIN ?? \"codex\";\n  const model = opts.model ?? process.env.CODEX_MODEL;\n  const timeoutMs =\n    opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 600000);\n\n  const tmp = mkdtempSync(path.join(os.tmpdir(), \"needlefish-\"));\n  const lastMsg = path.join(tmp, \"last.txt\");\n  const args = [\"exec\", \"--color\", \"never\", \"-s\", \"read-only\", \"--output-last-message\", lastMsg];\n  if (model) args.push(\"-m\", model);\n\n  const res = spawnSync(bin, args, {\n    cwd: opts.repoPath,\n    input: prompt,\n    encoding: \"utf8\",\n    timeout: timeoutMs,\n    maxBuffer: 1024 * 1024 * 64,\n  });\n\n  let out = \"\";\n  try {\n    out = readFileSync(lastMsg, \"utf8\");\n  } catch {\n    out = res.stdout ?? \"\";\n  }\n  rmSync(tmp, { recursive: true, force: true });\n\n  if (res.error) throw res.error;\n  if (res.status !== 0) {\n    throw new Error(\n      `codex exec exited ${res.status}: ${(res.stderr ?? \"\").slice(0, 2000)}`\n    );\n  }\n  return out;\n}\n\nexport function extractJson(text: string): any {\n  const fence = text.match(/```(?:json)?\\s*([\\s\\S]*?)```/i);\n  const raw = fence ? fence[1] : text;\n  const start = raw.indexOf(\"{\");\n  const end = raw.lastIndexOf(\"}\");\n  if (start === -1 || end === -1 || end <= start) {\n    throw new Error(\"no JSON object found in codex output\");\n  }\n  return JSON.parse(raw.slice(start, end + 1));\n}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "GH_TOKEN|GITHUB_TOKEN|inherit.{0,20}(env|token)|env\\s*override|sanitiz.{0,20}env|write.?token|scrub.{0,20}(token|env)|mutate.{0,20}(review|check)" },
    ],
    anchorFile: "src/shared/codex.ts",
  },
  provenance: { repo: "frankekn/needlefish", pr: 1, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/1#discussion_r3481222778", fixSha: "68e5e34ca1f099547b00db8c40f3fe12cb750219" },
};

export default spec;
