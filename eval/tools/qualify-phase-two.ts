import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { loadFixtures } from "../shared/fixture-catalog";
import { admitPhaseTwoReports, parsePhaseTwoPolicy, parsePhaseTwoReport } from "../shared/phase-two-input";
import { evaluatePhaseTwoQualification } from "../shared/qualification";
import { phaseTwoOracleIdentity } from "../shared/quality-oracle";
import type { FixtureSpec } from "../shared/types";

export const MAX_PHASE_TWO_INPUT_BYTES = 32 * 1024 * 1024;
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

function readInput(path: string): { value: unknown; sha256: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("Phase 2 input must be a regular file");
    if (stat.size > MAX_PHASE_TWO_INPUT_BYTES) throw new Error("Phase 2 input exceeds byte cap");
    const bytes = Buffer.alloc(MAX_PHASE_TWO_INPUT_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_PHASE_TWO_INPUT_BYTES) throw new Error("Phase 2 input exceeds byte cap");
    const raw = bytes.subarray(0, length);
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw));
    return { value, sha256: digest(raw) };
  } finally { closeSync(fd); }
}

function evaluatorSource() {
  const files = [
    "tools/qualify-phase-two.ts", "shared/phase-two-input.ts", "shared/qualification.ts", "shared/quality-oracle.ts",
    "shared/fixture-catalog.ts", "shared/report-completeness.ts", "shared/report-integrity.ts", "shared/publication.ts",
    "shared/score.ts", "shared/robustness.ts", "shared/types.ts", "gen-site.ts",
    "../src/shared/runner-attestation.ts", "../src/shared/public-runtime-identity.ts",
  ];
  const hashes = Object.fromEntries(files.map((file) => [file, digest(readFileSync(new URL(`../${file}`, import.meta.url)))]));
  return { sha256: digest(JSON.stringify(hashes)), files: hashes };
}

export async function main(args: readonly string[], catalog: () => readonly FixtureSpec[] | Promise<readonly FixtureSpec[]> = () => loadFixtures(null)): Promise<number> {
  if (args.length !== 5 || args.some((arg) => !arg || arg.startsWith("--"))) {
    throw new Error("Usage: tsx eval/tools/qualify-phase-two.ts BROAD.json DEEP.json ORACLE.json POLICY.json NEW_MEASUREMENT.json");
  }
  const [broadPath, deepPath, oraclePath, policyPath, outputPath] = args;
  const broadInput = readInput(broadPath);
  const deepInput = readInput(deepPath);
  const oracleInput = readInput(oraclePath);
  const policyInput = readInput(policyPath);
  const campaign = { broad: parsePhaseTwoReport(broadInput.value), deep: parsePhaseTwoReport(deepInput.value) };
  const policy = parsePhaseTwoPolicy(policyInput.value);
  const specs = await catalog();
  admitPhaseTwoReports(campaign, specs, policy);
  const result = evaluatePhaseTwoQualification(campaign, specs, policy, oracleInput.value);
  const measurement = {
    schemaVersion: 1, status: "measurement_only", gateClass: "R", result,
    inputSha256: { broad: broadInput.sha256, deep: deepInput.sha256, oracle: oracleInput.sha256, policy: policyInput.sha256 },
    oracleIdentity: phaseTwoOracleIdentity(campaign, specs), policyId: policy.id,
    policySha256: digest(JSON.stringify(policy)), reportSourceGitSha: campaign.broad.gitSha,
    evaluatorSource: evaluatorSource(),
    externalEvidence: "not_verified: independent authorship, blind adjudication, pre-run immutable gold, owner policy approval and campaign admission",
  };
  writeFileSync(outputPath, `${JSON.stringify(measurement, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return result.eligible ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = await main(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "phase_two_measurement_failed"}\n`);
    process.exitCode = 1;
  }
}
