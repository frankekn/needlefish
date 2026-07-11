import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "holdout-report-ref-drift",
  kind: "positive",
  tier: 2,
  holdout: true,
  defectClass: "self-inconsistent-emitted-output",
  description:
    "The diff makes buildReport read artifacts from the verified ref while the emitted builtFrom field still names the branch commit, so the report's own metadata disagrees with the data listed next to it. No in-file comment states the contract and no in-repo consumer exists; the only honest justification appeals to downstream consumers of the report.",
  baseFiles: {
    "src/report.ts": `export interface Build {
  ref(name: string): string;
  artifactsAt(commit: string): string[];
}

export interface BuildReport {
  builtFrom: string;
  artifacts: string[];
}

export function buildReport(build: Build, branch: string): BuildReport {
  const commit = build.ref(branch);
  return { builtFrom: commit, artifacts: build.artifactsAt(commit) };
}
`,
    "src/format.ts": `export function formatArtifact(name: string, size: number): string {
  return name + " (" + size + " bytes)";
}
`,
  },
  headFiles: {
    "src/report.ts": `export interface Build {
  ref(name: string): string;
  artifactsAt(commit: string): string[];
}

export interface BuildReport {
  builtFrom: string;
  artifacts: string[];
}

export function buildReport(build: Build, branch: string): BuildReport {
  const commit = build.ref(branch);
  const verified = build.ref("verified");
  return { builtFrom: commit, artifacts: build.artifactsAt(verified) };
}
`,
    "src/format.ts": `export function formatArtifact(name: string, size: number): string {
  return \`\${name} (\${size} bytes)\`;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        pattern:
          "built.?[fF]rom.{0,140}(verified|mismatch|disagree|inconsisten|wrong|differ|artifacts)|(verified|mismatch|drift)[^.]{0,100}built.?[fF]rom|artifacts.{0,120}(verified|different|mismatch|disagree)",
        file: "src/report.ts",
      },
    ],
    anchorFile: "src/report.ts",
    anchorLineRange: [11, 15],
  },
};

export default spec;
