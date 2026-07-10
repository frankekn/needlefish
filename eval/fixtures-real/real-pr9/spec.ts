// GENERATED SKELETON by eval/tools/pr2fixture.ts — DO NOT ship as-is.
// A human curator MUST replace every TODO-CURATOR placeholder using the
// evidence from the PR's review thread (provenance.evidenceUrl), never from
// the PR's code diff itself: mustFind/mustNotFind patterns are the eval's
// answer key, and an answer key derived from the code it's grading is
// cheat-proof-broken by construction. Also add anchorFile/anchorLineRange
// once the defect location is confirmed.
import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "real-pr9",
  kind: "positive",
  tier: 2,
  defectClass: "boundary-flip-accepts-zero",
  description:
    "Real PR (rejected in review): parsePositiveInteger guard flips `parsed <= 0` to `parsed < 0`, silently accepting 0 as a \"positive integer\". Live paths like `needlefish pr 0` now pass validation. Source: https://github.com/frankekn/needlefish/pull/9.",
  baseFiles: {
    "src/shared/runner.ts": "export const RUNNERS = [\"codex\", \"claude\", \"opencode\", \"openai\", \"grok\"] as const;\n\nexport type RunnerName = (typeof RUNNERS)[number];\n\nexport interface RunnerOptions {\n  readonly runner?: RunnerName;\n  readonly model?: string;\n  readonly timeoutMs?: number;\n  readonly reasoningEffort?: string;\n}\n\nexport interface RunStat {\n  readonly label: string;\n  readonly runner: RunnerName;\n  readonly model?: string;\n  readonly durationMs: number;\n  readonly attempts: number;\n  readonly ok: boolean;\n}\n\nexport function isRunnerName(value: string): value is RunnerName {\n  return value === \"codex\" || value === \"claude\" || value === \"opencode\" || value === \"openai\" || value === \"grok\";\n}\n\nexport function parseRunnerName(value: string, label: string): RunnerName {\n  if (isRunnerName(value)) return value;\n  throw new Error(`${label} must be one of: ${RUNNERS.join(\", \")}`);\n}\n\nexport function parsePositiveInteger(value: string, label: string): number {\n  const parsed = Number(value);\n  if (!Number.isInteger(parsed) || parsed <= 0) {\n    throw new Error(`${label} requires a positive integer`);\n  }\n  return parsed;\n}\n",
  },
  headFiles: {
    "src/shared/runner.ts": "export const RUNNERS = [\"codex\", \"claude\", \"opencode\", \"openai\", \"grok\"] as const;\n\nexport type RunnerName = (typeof RUNNERS)[number];\n\nexport interface RunnerOptions {\n  readonly runner?: RunnerName;\n  readonly model?: string;\n  readonly timeoutMs?: number;\n  readonly reasoningEffort?: string;\n}\n\nexport interface RunStat {\n  readonly label: string;\n  readonly runner: RunnerName;\n  readonly model?: string;\n  readonly durationMs: number;\n  readonly attempts: number;\n  readonly ok: boolean;\n}\n\nexport function isRunnerName(value: string): value is RunnerName {\n  return value === \"codex\" || value === \"claude\" || value === \"opencode\" || value === \"openai\" || value === \"grok\";\n}\n\nexport function parseRunnerName(value: string, label: string): RunnerName {\n  if (isRunnerName(value)) return value;\n  throw new Error(`${label} must be one of: ${RUNNERS.join(\", \")}`);\n}\n\nexport function parsePositiveInteger(value: string, label: string): number {\n  const parsed = Number(value);\n  if (!Number.isInteger(parsed) || parsed < 0) {\n    throw new Error(`${label} requires a positive integer`);\n  }\n  return parsed;\n}\n",
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "zero|\\b0\\b.{0,24}(accept|allow|valid|pass)|(accept|allow|permit)s?.{0,24}\\b0\\b|positive integer.{0,32}(0|zero)|<=?\\s*0|boundary" },
    ],
    anchorFile: "src/shared/runner.ts",
  },
  provenance: { repo: "frankekn/needlefish", pr: 9, kind: "review-finding", evidenceUrl: "https://github.com/frankekn/needlefish/pull/9" },
};

export default spec;
