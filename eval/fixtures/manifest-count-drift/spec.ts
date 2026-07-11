import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "manifest-count-drift",
  kind: "positive",
  tier: 2,
  defectClass: "self-inconsistent-emitted-output",
  description:
    "The diff filters stale entries out of the manifest rows but the emitted `# entry-count` header still counts the unfiltered input, so the manifest's own header disagrees with the rows it lists. Fully observable in the single changed file; the manifest is parsed by external tools, so no in-repo consumer exists to cite.",
  baseFiles: {
    "src/manifest.ts": `export interface Entry {
  path: string;
  size: number;
  stale: boolean;
}

export interface ManifestOptions {
  tool: string;
  version: string;
}

function headerLines(opts: ManifestOptions, count: number): string[] {
  return [
    \`# generated-by: \${opts.tool} \${opts.version}\`,
    \`# entry-count: \${count}\`,
  ];
}

export function renderManifest(entries: Entry[], opts: ManifestOptions): string {
  const rows = entries.map((e) => \`\${e.path}\\t\${e.size}\`);
  return [...headerLines(opts, entries.length), ...rows].join("\\n");
}
`,
  },
  headFiles: {
    "src/manifest.ts": `export interface Entry {
  path: string;
  size: number;
  stale: boolean;
}

export interface ManifestOptions {
  tool: string;
  version: string;
}

function headerLines(opts: ManifestOptions, count: number): string[] {
  return [
    \`# generated-by: \${opts.tool} \${opts.version}\`,
    \`# entry-count: \${count}\`,
  ];
}

export function renderManifest(entries: Entry[], opts: ManifestOptions): string {
  const live = entries.filter((e) => !e.stale);
  const rows = live.map((e) => \`\${e.path}\\t\${e.size}\`);
  return [...headerLines(opts, entries.length), ...rows].join("\\n");
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        pattern:
          "(entry.?count|\\bcount\\b|header).{0,140}(stale|filter|unfiltered|live|mismatch|disagree|inconsisten|entries\\.length|all entries|wrong)|(stale|unfiltered|filtered)[^.]{0,100}(entry.?count|\\bcount\\b|header)",
      },
    ],
    anchorFile: "src/manifest.ts",
    anchorLineRange: [19, 23],
  },
};

export default spec;
