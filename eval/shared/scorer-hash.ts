import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// The scoring-relevant sources. Two reports are only comparable when both were
// scored by the same code; any edit here changes the hash, so resume/compare/
// weekly/doc generators refuse to mix generations. gate-verdict.mjs replicates
// this exact digest (same files, order, and separators) in plain JS.
const SCORER_FILES = ["score.ts", "robustness.ts", "types.ts"];

export function scorerHash(): string {
  const hash = createHash("sha256");
  for (const name of SCORER_FILES) {
    const content = readFileSync(path.join(__dirname, name), "utf8");
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
