import { openSync, fstatSync, readSync, closeSync, constants, mkdirSync, writeFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluatorMetadata, importManifest, maxManifestBytes, parseManifest } from "./manifest.js";

function readManifest(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("manifest_not_regular_file");
    const bytes = Buffer.alloc(maxManifestBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > maxManifestBytes) throw new Error("manifest_too_large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}

export function main(args: string[]): void {
  const [manifestPath, outputPath, ...rest] = args;
  if (!manifestPath || !outputPath || (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--repo"))) {
    throw new Error("Usage: tsx eval/external/import.ts MANIFEST NEW_OUTPUT_DIRECTORY [--repo LOCAL_REPO]");
  }
  const manifest = parseManifest(readManifest(manifestPath));
  const result = importManifest(manifest, rest[1]);
  const output = resolve(outputPath);
  mkdirSync(output, { mode: 0o700 });
  writeFileSync(join(output, "evaluator.json"), `${JSON.stringify(evaluatorMetadata(manifest, result), null, 2)}\n`, { flag: "wx", mode: 0o600 });
  if (result.status === "source-ready") {
    mkdirSync(join(output, "reviewer"), { mode: 0o700 });
    writeFileSync(join(output, "reviewer", "input.json"), `${JSON.stringify(result.reviewer, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  }
  process.stdout.write(`${JSON.stringify({ status: result.status, output })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "import_failed"}\n`);
    process.exitCode = 1;
  }
}
