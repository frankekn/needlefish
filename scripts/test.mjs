import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

function collectTests(dir) {
  const tests = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      tests.push(...collectTests(path));
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      tests.push(path);
    }
  }
  return tests;
}

const files = collectTests("src").sort();
if (files.length === 0) {
  process.stderr.write("No test files found under src.\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", "--import", "tsx", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
