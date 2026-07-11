import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "publish-commit-drift",
  kind: "positive",
  tier: 2,
  defectClass: "self-inconsistent-emitted-output",
  description:
    "The diff makes publishSnapshot read the file list from the stable ref while the emitted commit field still names the channel head, so the snapshot's own metadata disagrees with the data computed next to it. No in-file comment states the contract and no in-repo consumer exists; the only honest justification appeals to downstream consumers of the snapshot.",
  baseFiles: {
    "src/publish.ts": `export interface Repo {
  headCommit(ref: string): string;
  filesAt(commit: string): string[];
}

export interface Snapshot {
  commit: string;
  channel: string;
  files: string[];
}

export function publishSnapshot(repo: Repo, channel: string): Snapshot {
  const head = repo.headCommit(channel);
  return {
    commit: head,
    channel,
    files: repo.filesAt(head),
  };
}
`,
    "src/channels.ts": `export const DEFAULT_CHANNEL = "main";

export function isValidChannel(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}
`,
  },
  headFiles: {
    "src/publish.ts": `export interface Repo {
  headCommit(ref: string): string;
  filesAt(commit: string): string[];
}

export interface Snapshot {
  commit: string;
  channel: string;
  files: string[];
}

export function publishSnapshot(repo: Repo, channel: string): Snapshot {
  const head = repo.headCommit(channel);
  const stable = repo.headCommit("stable");
  return {
    commit: head,
    channel,
    files: repo.filesAt(stable),
  };
}
`,
    "src/channels.ts": `export const DEFAULT_CHANNEL = "main";

export function isValidChannel(name: string): boolean {
  return /^[a-z][a-z0-9-]*$/.test(name);
}

export function normalizeChannel(name: string): string {
  return name.trim().toLowerCase();
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        pattern:
          "commit.{0,140}(stable|mismatch|disagree|inconsisten|wrong|differ|files)|(stable|mismatch|drift)[^.]{0,100}commit|files.{0,120}(stable|different commit|mismatch|disagree)",
        file: "src/publish.ts",
      },
    ],
    anchorFile: "src/publish.ts",
    anchorLineRange: [12, 20],
  },
};

export default spec;
