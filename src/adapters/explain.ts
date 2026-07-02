import path from "node:path";
import { explainFinding } from "../core/explain";
import { ghText } from "../shared/repo";
import type { RunnerOptions } from "../shared/runner";
import { prDiffBundle } from "./local";

// `@needlefish explain <key>` — one model call, posted as an issue comment.
// The key is sanitized in explainFinding; this layer only does IO.
export async function runGithubExplain(
  cwd: string,
  prNumber: number,
  findingKey: string,
  opts: RunnerOptions
): Promise<void> {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error("GITHUB_REPOSITORY not set (must run in Actions)");
  const repoPath = path.resolve(cwd);
  const bundle = prDiffBundle(repoPath, prNumber, opts);
  const explanation = await explainFinding(bundle, findingKey, opts);
  const body = `## 🔍 Needlefish explain\n\n${explanation}\n\n<sub>Explanation only — the review verdict is unchanged.</sub>`;
  ghText(
    ["api", "-X", "POST", `repos/${repo}/issues/${prNumber}/comments`, "--input", "-"],
    repoPath,
    JSON.stringify({ body })
  );
  process.stdout.write(explanation + "\n");
}
