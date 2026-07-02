import { readFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, "..", "..", "prompts");
const PROMPT_FILES = ["review.md", "deep.md", "critic.md", "map.md"];

export function promptHash(): string {
  const hash = createHash("sha256");
  for (const name of PROMPT_FILES) {
    const content = readFileSync(path.join(PROMPTS_DIR, name), "utf8");
    hash.update(name);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
