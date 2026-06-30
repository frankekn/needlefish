import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const tmp = mkdtempSync(join(tmpdir(), "needlefish-shim-"));
const fakebin = join(tmp, "fakebin");
mkdirSync(fakebin);
const readlink = join(fakebin, "readlink");
writeFileSync(
  readlink,
  `#!/bin/sh
if [ "$1" = "--" ]; then
  exit 126
fi
exec /usr/bin/readlink "$@"
`,
);
chmodSync(readlink, 0o755);

const symlinkedBin = join(tmp, "needlefish");
symlinkSync(join(process.cwd(), "bin", "needlefish"), symlinkedBin);
const shimResult = spawnSync(symlinkedBin, ["--version"], {
  env: { ...process.env, PATH: `${fakebin}:${process.env.PATH ?? ""}` },
  encoding: "utf8",
});
rmSync(tmp, { recursive: true, force: true });
if (shimResult.status !== 0) {
  process.stderr.write(shimResult.stdout);
  process.stderr.write(shimResult.stderr);
  process.exit(shimResult.status ?? 1);
}

const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--import", "tsx", ...files], {
  stdio: "inherit",
});

process.exit(result.status ?? 1);
