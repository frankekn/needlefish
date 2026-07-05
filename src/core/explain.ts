import { runCodex } from "../shared/codex.js";
import type { RunnerOptions } from "../shared/runner.js";
import type { Bundle } from "../shared/schema.js";
import { loadPrompt } from "./prompts.js";

// Untrusted comment text becomes a plain search key: strip everything but
// word chars and light punctuation so it cannot smuggle markup or newlines.
export function sanitizeFindingKey(raw: string): string {
  return raw.replace(/[^\w .:/#-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

export async function explainFinding(
  bundle: Bundle,
  findingKey: string,
  opts: RunnerOptions
): Promise<string> {
  const key = sanitizeFindingKey(findingKey);
  if (!key) throw new Error("explain: finding key is empty after sanitizing");
  const { patch, ...meta } = bundle;
  const prompt = loadPrompt("explain.md")
    .replace("{{FINDING_KEY}}", () => key)
    .replace("{{BUNDLE}}", () => JSON.stringify(meta, null, 2))
    .replace("{{PATCH}}", () => patch);
  const out = await runCodex(prompt, {
    repoPath: bundle.repoPath,
    targetHeadSha: bundle.headSha,
    label: "explain",
    ...opts,
  });
  return out.trim();
}
