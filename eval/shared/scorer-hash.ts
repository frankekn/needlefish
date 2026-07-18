import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCORER_FILES = ["score.ts", "robustness.ts", "types.ts"] as const;
const scorerDir = path.dirname(fileURLToPath(import.meta.url));

export function scorerHash(): string {
  const hash = createHash("sha256");
  for (const name of SCORER_FILES) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(path.join(scorerDir, name), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
