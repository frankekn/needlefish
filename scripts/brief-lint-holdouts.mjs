#!/usr/bin/env node

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

async function collect(repoPath) {
  const holdouts = [];
  for (const relativeRoot of [join("eval", "fixtures"), join("eval", "fixtures-real")]) {
    const root = join(repoPath, relativeRoot);
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const specPath = join(root, entry.name, "spec.ts");
      try {
        if (!(await stat(specPath)).isFile()) throw new Error("invalid spec path");
      } catch (error) {
        throw error;
      }
      const module = await import(pathToFileURL(specPath).href);
      const spec = module.default ?? module.spec;
      if (spec === null || typeof spec !== "object" || Array.isArray(spec)) {
        throw new Error("invalid spec export");
      }
      if (typeof spec.id !== "string" || spec.id.trim().length === 0) {
        throw new Error("invalid spec id");
      }
      if (spec.holdout === true) holdouts.push(spec.id);
    }
  }
  return holdouts;
}

try {
  process.stdout.write(`${JSON.stringify(await collect(process.argv[2]))}\n`);
} catch {
  process.exitCode = 1;
}
