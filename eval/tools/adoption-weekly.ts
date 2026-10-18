import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderReport, type AdoptionRow } from "./adoption";
import { measurementOptions, parseFindingMeasurement, type MeasurementContract } from "./adoption-measurements.js";

const REPO = "frankekn/needlefish";
const ROOT = fileURLToPath(new URL("../../", import.meta.url));

function parseRows(raw: string): AdoptionRow[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value)) throw new Error("collector output must be an array");
  return value.map((row: unknown) => {
    if (typeof row !== "object" || row === null || !("repo" in row) || row.repo !== REPO
      || !("pr" in row) || typeof row.pr !== "number" || !Number.isInteger(row.pr)
      || !("severity" in row) || typeof row.severity !== "string"
      || !("category" in row) || typeof row.category !== "string"
      || !("fate" in row) || (row.fate !== "addressed" && row.fate !== "kept" && row.fate !== "pending" && row.fate !== "abandoned")
      || !("resolved" in row) || typeof row.resolved !== "boolean"
      || !("path" in row) || typeof row.path !== "string"
      || !("created" in row) || typeof row.created !== "string" || !Number.isFinite(Date.parse(row.created))
      || !("author" in row) || (row.author !== null && typeof row.author !== "string")) {
      throw new Error("invalid collector row");
    }
    const measurement = "measurement" in row ? parseFindingMeasurement(row.measurement) : undefined;
    if (measurement?.status === "producer_attested" && (measurement.receipt.repository !== row.repo || measurement.receipt.prNumber !== row.pr)) throw new Error("measurement row identity conflict");
    return { repo: row.repo, pr: row.pr, severity: row.severity, category: row.category,
      fate: row.fate, resolved: row.resolved, path: row.path, created: row.created, author: row.author,
      ...(measurement ? { measurement } : {}) };
  });
}

export function writeWeeklyReport(options: {
  readonly outputDir: string;
  readonly now: Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly measurements?: MeasurementContract;
}): number {
  const env = options.env ?? process.env;
  if (env.GITHUB_REPOSITORY && env.GITHUB_REPOSITORY !== REPO) {
    throw new Error(`weekly adoption is restricted to ${REPO}`);
  }
  const end = new Date(options.now);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const since = start.toISOString().slice(0, 10);
  const until = end.toISOString();
  const source = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" });
  const sourceSha = source.stdout?.trim();
  if (source.status !== 0 || !/^[a-f0-9]{40}$/.test(sourceSha)) throw new Error("cannot determine source SHA");
  mkdirSync(options.outputDir, { recursive: false });
  const save = (name: string, content: string) => writeFileSync(path.join(options.outputDir, name), content);
  save("source-sha.txt", `${sourceSha}\n`);
  const measurementArgs = options.measurements ? ["--measurement-workflow", options.measurements.workflowPath, "--measurement-job-key", options.measurements.jobKey, "--measurement-job-name", options.measurements.jobName] : [];
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(ROOT, "eval/tools/adoption.ts"), REPO, "--since", since, "--json", ...measurementArgs], {
    cwd: ROOT, env, encoding: "utf8", timeout: 10 * 60 * 1000, maxBuffer: 64 * 1024 * 1024,
  });
  const stderr = result.stderr ?? "";
  save("stderr.txt", stderr);
  save("collector.json", result.stdout ?? "");
  let rows: AdoptionRow[] = [];
  let error: string | null = null;
  try {
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`collector exited ${result.status ?? result.signal}`);
    rows = parseRows(result.stdout).filter((row) => Date.parse(row.created) >= start.getTime() && Date.parse(row.created) < end.getTime());
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const warnings = stderr.split("\n").filter((line) => line && !/^adoption: frankekn\/needlefish: \d+ finding threads$/.test(line));
  const unknownCategories = rows.filter((row) => row.category === "unknown").length;
  const unknownMeasurements = options.measurements ? rows.filter((row) => row.measurement?.status !== "producer_attested").length : null;
  const status = error ? "failed" : warnings.length > 0 || unknownCategories > 0 || (unknownMeasurements ?? 0) > 0 ? "partial" : "collected";
  save("rows.json", `${JSON.stringify(rows, null, 2)}\n`);
  save("metadata.json", `${JSON.stringify({ repo: REPO, sourceSha, since: start.toISOString(), until,
    status, error, findingThreads: rows.length, unknownCategories, warnings,
    measurements: options.measurements ? { contract: options.measurements, findingDenominator: rows.length, unknown: unknownMeasurements, scope: "producer_attested_only" } : { status: "not_requested" },
    completeness: "The collector reads at most 100 threads per PR. Available history cannot prove that inaccessible edits had no category conflicts.",
  }, null, 2)}\n`);
  save("report.md", ["# Weekly Needlefish adoption", "", `Repository: ${REPO}`,
    `UTC window: [${start.toISOString()}, ${until})`, `Source: ${sourceSha}`,
    `Collection status: ${status}. Unknown categories: ${unknownCategories}.`,
    "Fates reflect GitHub state at collection time, not at the window end.",
    "Collection success does not certify complete history. See metadata.json and stderr.txt.", "",
    ...(error ? [`Collection failed: ${error}`, "No adoption totals are available."] : [renderReport(rows, since)]),
    "", "## Collector diagnostics", "", ...warnings.map((line) => `    ${line}`), "",
  ].join("\n"));
  return error ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    if (process.argv.length < 3) throw new Error("Usage: tsx eval/tools/adoption-weekly.ts <new-output-directory> [explicit measurement options]");
    const measurements = process.argv.length > 3 ? measurementOptions(process.argv.slice(3)) : undefined;
    process.exitCode = writeWeeklyReport({ outputDir: process.argv[2], now: new Date(), measurements });
  } catch (err) {
    process.stderr.write(`weekly adoption failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
