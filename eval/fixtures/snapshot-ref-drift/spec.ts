import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "snapshot-ref-drift",
  kind: "positive",
  tier: 2,
  defectClass: "self-inconsistent-emitted-output",
  description:
    "The diff makes buildChangeset compute changedPaths against the latest revision while the emitted fromRevision label still reports the pinned revision, so the changeset's own metadata disagrees with the data computed next to it. The documented contract says consumers replay on exactly fromRevision; no in-repo consumer exists to cite.",
  baseFiles: {
    "src/changeset.ts": `export interface Store {
  resolve(tag: string): string;
  readChangedPaths(fromRevision: string): string[];
}

export interface Changeset {
  // Revision the changed paths were computed against. Consumers replay the
  // changeset on top of exactly this revision.
  fromRevision: string;
  changedPaths: string[];
}

export function buildChangeset(store: Store, pinnedTag: string): Changeset {
  const from = store.resolve(pinnedTag);
  return {
    fromRevision: from,
    changedPaths: store.readChangedPaths(from),
  };
}
`,
  },
  headFiles: {
    "src/changeset.ts": `export interface Store {
  resolve(tag: string): string;
  readChangedPaths(fromRevision: string): string[];
}

export interface Changeset {
  // Revision the changed paths were computed against. Consumers replay the
  // changeset on top of exactly this revision.
  fromRevision: string;
  changedPaths: string[];
}

export function buildChangeset(store: Store, pinnedTag: string): Changeset {
  const from = store.resolve(pinnedTag);
  const latest = store.resolve("latest");
  return {
    fromRevision: from,
    changedPaths: store.readChangedPaths(latest),
  };
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      {
        pattern:
          "from.?[rR]evision.{0,140}(latest|mismatch|disagree|inconsisten|wrong|stale|pinned|computed|align|differ)|(latest|mismatch|drift)[^.]{0,100}from.?[rR]evision|changed.?[pP]aths.{0,120}(latest|different revision|mismatch|disagree)",
      },
    ],
    anchorFile: "src/changeset.ts",
    anchorLineRange: [13, 20],
  },
};

export default spec;
