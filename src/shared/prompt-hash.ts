import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export function promptHash(): string {
  const hash = createHash("sha256");
  for (const name of ["review.md", "deep.md", "critic.md", "map.md", "finding-contract.md"]) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(new URL(`../../prompts/${name}`, import.meta.url), "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}
