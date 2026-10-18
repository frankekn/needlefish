import { openSync, fstatSync, readSync, closeSync, constants, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { maxManifestBytes, parseManifest } from "./manifest.js";
import { maxResultBytes, parseEvaluator, parseProductResults, scoreProductResults } from "./results.js";

function readJSON(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("input_not_regular_file");
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > limit) throw new Error("input_too_large");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
export function main(args: string[]): void {
  const [manifestPath, evaluatorPath, resultsPath, outputPath, ...rest] = args;
  if (!manifestPath || !evaluatorPath || !resultsPath || !outputPath || (rest.length !== 0 && (rest.length !== 2 || rest[0] !== "--repo" || !rest[1]))) {
    throw new Error("Usage: tsx eval/external/score.ts MANIFEST EVALUATOR PRODUCT_RESULTS NEW_SCORE_FILE [--repo LOCAL_REPO]");
  }
  const manifest = parseManifest(readJSON(manifestPath, maxManifestBytes));
  const evaluator = parseEvaluator(readJSON(evaluatorPath, maxResultBytes));
  const results = parseProductResults(readJSON(resultsPath, maxResultBytes));
  const report = scoreProductResults(manifest, evaluator, results, rest[1]);
  writeFileSync(resolve(outputPath), `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ status: report.status, output: resolve(outputPath) })}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "score_failed"}\n`);
    process.exitCode = 1;
  }
}
