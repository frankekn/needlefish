import { createHash, randomUUID } from "node:crypto";
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fixtureClassifications, qualifyRuntimeConfiguration, parseLane, readManifest, type FixtureClassifications, type LaneConfig } from "./gen-site";
import { loadFixtures } from "./shared/fixture-catalog";
import { parseQualificationProof, QUALIFICATION_POLICY, type QualificationProof } from "../src/shared/qualification-proof.js";

export function createQualificationProof(reportBytes: string, config: LaneConfig, canonical: FixtureClassifications, exactSource: string): QualificationProof {
  const lane = parseLane(config, reportBytes);
  if (!/^[a-f0-9]{40}$/.test(exactSource) || lane.report.gitSha !== exactSource) throw new Error("qualification report does not identify the exact release source");
  const admitted = qualifyRuntimeConfiguration(lane.report, lane, canonical);
  if (admitted.matchStatus !== "tested") throw new Error(`qualification proof refused: ${admitted.reason}`);
  const report = lane.report;
  return parseQualificationProof({ version: 1, policyVersion: QUALIFICATION_POLICY, reportId: admitted.reportId,
    reportSha256: createHash("sha256").update(reportBytes).digest("hex"),
    identity: { runner: report.runner, model: report.model, effort: report.effort, promptHash: report.promptHash,
      gitSha: report.gitSha, gateClass: report.gateClass, scorerHash: report.scorerHash,
      fixtureSetHash: report.fixtureSetHash, anticheatVersion: report.anticheatVersion,
      provider: report.provider, route: report.route, runnerVersion: report.runnerVersion,
      runnerEnvironment: report.runnerEnvironment, privateEnvironment: report.privateEnvironment,
    } });
}

async function main(args: readonly string[]): Promise<void> {
  const [releaseFile, reportId] = args;
  if (args.length !== 2 || !releaseFile || !reportId) throw new Error("usage: node --import tsx eval/qualify-release.ts <release.json> <results/report.json>");
  const config = readManifest().lanes.find(lane => lane.report === reportId);
  if (!config) throw new Error("qualification report must be a configured public lane");
  const release: unknown = JSON.parse(readFileSync(releaseFile, "utf8"));
  if (typeof release !== "object" || release === null || !("sha" in release) || typeof release.sha !== "string" || "base_sha" in release || "patch_sha256" in release) throw new Error("qualification requires an exact source release manifest");
  const bytes = readFileSync(new URL(config.report, import.meta.url), "utf8");
  const proof = createQualificationProof(bytes, config, fixtureClassifications(await loadFixtures(null)), release.sha);
  const target = realpathSync(releaseFile);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ ...release, qualification: proof }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => { process.stderr.write("qualification proof generation failed; release was not qualified.\n"); process.exitCode = 1; });
