import type { Bundle, Hotspot } from "../shared/schema.js";
import type { RunnerSandbox } from "../shared/runner-sandbox.js";
import { collectLiteralContext, LITERAL_CONTEXT_CAPS, type LiteralContextCollection, type LiteralContextSeed } from "./literal-context.js";

const KEYWORDS = new Set("as async await break case catch class const continue default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return static super switch this throw true try type typeof undefined var void while yield".split(" "));

export interface LargeLiteralContext {
  readonly collection: LiteralContextCollection;
  readonly anchorOwners: readonly { readonly revision: string; readonly path: string; readonly changedPath: string }[];
}

type Snapshot = Pick<RunnerSandbox, "repoPath" | "expectedHeadSha" | "expectedBaseSha">;

function patchPath(header: string): string | undefined {
  let value = header;
  if (header.startsWith('"')) {
    try { const decoded: unknown = JSON.parse(header); if (typeof decoded !== "string") return; value = decoded; }
    catch { return; }
  }
  if (value === "/dev/null") return;
  return /^[ab]\//.test(value) ? value.slice(2) : undefined;
}

export function changedLiteralSeeds(bundle: Bundle, snapshot: Snapshot): {
  readonly seeds: readonly LiteralContextSeed[];
  readonly gaps: readonly string[];
  readonly anchorOwners: LargeLiteralContext["anchorOwners"];
} {
  const changed = new Set(bundle.changedFiles.map((file) => file.path));
  const oldSeeds: LiteralContextSeed[] = [];
  const newSeeds: LiteralContextSeed[] = [];
  const seen = new Set<string>();
  const gaps = new Set<string>();
  const anchorOwners: { revision: string; path: string; changedPath: string }[] = [];
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  const add = (pool: LiteralContextSeed[], revision: string | undefined, file: string | undefined, line: number, text: string, changedPath: string) => {
    if (revision === undefined || file === undefined) return;
    for (const match of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
      const identifier = match[0];
      if (KEYWORDS.has(identifier) || Buffer.byteLength(identifier) > LITERAL_CONTEXT_CAPS.identifierBytes) continue;
      const key = JSON.stringify([revision, file, identifier]);
      if (seen.has(key)) continue;
      if (pool.length >= LITERAL_CONTEXT_CAPS.seeds) { gaps.add("seed_count_cap"); break; }
      seen.add(key);
      pool.push({ revision, path: file, line, identifier });
      anchorOwners.push({ revision, path: file, changedPath });
    }
  };
  for (const row of bundle.patch.split("\n")) {
    if (row.startsWith("diff --git ")) {
      if (oldRemaining !== 0 || newRemaining !== 0) gaps.add("unsupported_diff_hunk");
      oldPath = newPath = undefined;
      oldRemaining = newRemaining = 0;
    } else if (oldRemaining === 0 && newRemaining === 0 && row.startsWith("--- ")) {
      oldPath = patchPath(row.slice(4));
      if (!oldPath && row !== "--- /dev/null") gaps.add("unsupported_diff_path");
    } else if (oldRemaining === 0 && newRemaining === 0 && row.startsWith("+++ ")) {
      newPath = patchPath(row.slice(4));
      if (!newPath && row !== "+++ /dev/null") gaps.add("unsupported_diff_path");
    } else if (row.startsWith("@@ ")) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row);
      if (!hunk) { gaps.add("unsupported_diff_hunk"); continue; }
      oldLine = Number(hunk[1]); newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1); newRemaining = Number(hunk[4] ?? 1);
    } else if (oldRemaining > 0 || newRemaining > 0) {
      const related = changed.has(newPath ?? oldPath ?? "");
      if (row.startsWith("-") && oldRemaining > 0) {
        if (related) add(oldSeeds, snapshot.expectedBaseSha, oldPath, oldLine, row.slice(1), newPath ?? oldPath ?? "");
        oldLine++; oldRemaining--;
      } else if (row.startsWith("+") && newRemaining > 0) {
        if (related) add(newSeeds, snapshot.expectedHeadSha, newPath, newLine, row.slice(1), newPath ?? oldPath ?? "");
        newLine++; newRemaining--;
      } else if (row.startsWith(" ") && oldRemaining > 0 && newRemaining > 0) {
        oldLine++; newLine++; oldRemaining--; newRemaining--;
      } else if (!row.startsWith("\\ No newline")) {
        gaps.add("unsupported_diff_hunk"); oldRemaining = newRemaining = 0;
      }
    }
  }
  if (oldRemaining !== 0 || newRemaining !== 0) gaps.add("unsupported_diff_hunk");
  const interleaved = oldSeeds.flatMap((seed, index) => newSeeds[index] ? [seed, newSeeds[index]] : [seed]);
  interleaved.push(...newSeeds.slice(oldSeeds.length));
  if (interleaved.length > LITERAL_CONTEXT_CAPS.seeds) gaps.add("seed_count_cap");
  const seeds = interleaved.slice(0, LITERAL_CONTEXT_CAPS.seeds);
  if (seeds.length === 0) gaps.add("no_changed_anchor_seed");
  return { seeds, gaps: [...gaps], anchorOwners };
}

export async function collectLargeLiteralContext(input: {
  readonly bundle: Bundle;
  readonly snapshot: Snapshot;
  readonly reviewDeadlineMs?: number;
  readonly abortSignal: AbortSignal;
}): Promise<LargeLiteralContext> {
  const selected = changedLiteralSeeds(input.bundle, input.snapshot);
  const result = await collectLiteralContext({ ...input, seeds: selected.seeds });
  const gaps = [...new Set([...result.gaps, ...selected.gaps])];
  const candidates = [...result.candidates];
  const collection = { ...result, gaps, candidates, status: gaps.length === 0 ? result.status : result.status === "unknown" ? "unknown" : "partial" } satisfies LiteralContextCollection;
  while (Buffer.byteLength(JSON.stringify(collection)) > LITERAL_CONTEXT_CAPS.jsonBytes && candidates.length > 0) {
    if (!gaps.includes("json_bytes_cap")) gaps.push("json_bytes_cap");
    candidates.pop();
  }
  return { anchorOwners: selected.anchorOwners, collection };
}

export function hotspotLiteralContext(context: LargeLiteralContext, hotspot: Hotspot): LiteralContextCollection {
  const candidates = context.collection.candidates.filter((candidate) => context.anchorOwners.some((owner) =>
    owner.revision === candidate.seed.revision && owner.path === candidate.seed.path
    && (hotspot.files.includes(owner.changedPath) || hotspot.edges.some((edge) => edge.consumerFile === owner.changedPath))));
  return { ...context.collection, candidates };
}
