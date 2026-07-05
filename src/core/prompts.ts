import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type PromptFile = "critic.md" | "deep.md" | "explain.md" | "map.md" | "review.md";

const PACKAGE_ROOT = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
const PROMPTS_DIR = path.join(PACKAGE_ROOT, "prompts");

export function loadPrompt(name: PromptFile): string {
  return readFileSync(path.join(PROMPTS_DIR, name), "utf8");
}

function findPackageRoot(startDir: string): string {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`needlefish package root not found from ${startDir}`);
    }
    dir = parent;
  }
}
