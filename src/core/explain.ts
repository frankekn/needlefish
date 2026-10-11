import { runCodex } from "../shared/codex.js";
import type { RunnerOptions } from "../shared/runner.js";
import type { Bundle } from "../shared/schema.js";
import { loadPrompt } from "./prompts.js";

// Untrusted comment text becomes a plain search key: strip everything but
// word chars and light punctuation so it cannot smuggle markup or newlines.
export function sanitizeFindingKey(raw: string): string {
  return raw.replace(/[^\w .:/#-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

// The finding keys of Needlefish's own latest review on the PR (the state
// marker's content). PR discussion no longer carries Needlefish's review
// text, so this is how the explain model learns which findings exist and
// where each one is anchored; the FINDING KEY is matched against these and
// the diff.
export interface LatestReview {
  readonly headSha: string;
  readonly findings: readonly {
    readonly file: string;
    readonly lineStart: number;
    readonly category: string;
    readonly title: string;
  }[];
}

export async function explainFinding(
  bundle: Bundle,
  findingKey: string,
  opts: RunnerOptions,
  latestReview: LatestReview | null = null
): Promise<string> {
  const key = sanitizeFindingKey(findingKey);
  if (!key) throw new Error("explain: finding key is empty after sanitizing");
  const { patch, ...meta } = bundle;
  const context = latestReview ? { ...meta, latestReview } : meta;
  const prompt = loadPrompt("explain.md")
    .replace("{{FINDING_KEY}}", () => key)
    .replace("{{BUNDLE}}", () => JSON.stringify(context, null, 2))
    .replace("{{PATCH}}", () => patch);
  const out = await runCodex(prompt, {
    repoPath: bundle.repoPath,
    targetHeadSha: bundle.headSha,
    label: "explain",
    ...opts,
  });
  return out.trim();
}
