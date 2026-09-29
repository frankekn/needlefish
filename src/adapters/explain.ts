import path from "node:path";
import { explainFinding } from "../core/explain.js";
import {
  credentialValuesFromEnv,
  screenText,
  WITHHELD_MESSAGE,
} from "../shared/outbound-screen.js";
import { ghText } from "../shared/repo.js";
import type { RunnerOptions } from "../shared/runner.js";
import { findPreviousReview } from "./github.js";
import { prDiffBundle } from "./local.js";

// The explanation is model text posted publicly and outside ghPost, so it
// gets the same screen as review output.
export function screenExplanation(explanation: string, env: NodeJS.ProcessEnv): string {
  const screened = screenText(explanation, credentialValuesFromEnv(env));
  switch (screened.kind) {
    case "clean":
      return explanation;
    case "redacted":
      return screened.text;
    case "withheld":
      throw new Error(WITHHELD_MESSAGE);
  }
}

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
  const { bundle } = prDiffBundle(repoPath, prNumber, opts);
  // Same trusted resolver as re-review: only a state marker written by the
  // identity this run posts as names the findings.
  const latestReview = findPreviousReview(repo, prNumber)?.state ?? null;
  const explanation = screenExplanation(
    await explainFinding(bundle, findingKey, opts, latestReview),
    process.env
  );
  // The trailing marker is recognized by normalize.ts isNeedlefishPost when
  // the comment is read back.
  const body = `## 🔍 Needlefish explain\n\n${explanation}\n\n<sub>Explanation only — the review verdict is unchanged.</sub>\n<!-- needlefish-explain -->`;
  ghText(
    ["api", "-X", "POST", `repos/${repo}/issues/${prNumber}/comments`, "--input", "-"],
    repoPath,
    JSON.stringify({ body })
  );
  process.stdout.write(explanation + "\n");
}
