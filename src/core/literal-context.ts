import { createHash } from "node:crypto";
import path from "node:path";
import { TextDecoder } from "node:util";
import { runManagedRunnerProcess, type ManagedRunnerProcessController } from "../shared/runner-process.js";
import type { RunnerSandbox } from "../shared/runner-sandbox.js";

export const LITERAL_CONTEXT_CAPS = Object.freeze({
  seeds: 8, identifierBytes: 64, files: 128, treeBytes: 16_384,
  blobBytes: 4096, scannedBytes: 16_384, hits: 32,
  snippetBytes: 240, jsonBytes: 8192, milliseconds: 1500,
});

export interface LiteralContextSeed {
  readonly revision: string;
  readonly path: string;
  readonly line: number;
  readonly identifier: string;
}

export interface LiteralContextCandidate {
  readonly seed: LiteralContextSeed;
  readonly revision: string;
  readonly path: string;
  readonly line: number;
  readonly blobOid: string;
  readonly contentSha256: string;
  readonly snippet: string;
  readonly snippetTruncated: boolean;
  readonly relationship: "unverified_literal";
  readonly semanticStatus: "unknown";
}

export interface LiteralContextCollection {
  readonly status: "complete_literal_search" | "partial" | "unknown";
  readonly semanticStatus: "unknown";
  readonly caps: typeof LITERAL_CONTEXT_CAPS;
  readonly scannedBytes: number;
  readonly scannedFiles: number;
  readonly gaps: readonly string[];
  readonly candidates: readonly LiteralContextCandidate[];
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
  readonly size: number | null;
}

class CollectionGap extends Error {}

function fixedRevision(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
}

function sourcePath(value: string): boolean {
  return value.length > 0 && !value.includes("\0") && !value.includes("\\")
    && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function decode(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CollectionGap("invalid_utf8");
  }
}

function treeEntries(bytes: Buffer): TreeEntry[] {
  const text = decode(bytes);
  if (text !== "" && !text.endsWith("\0")) throw new CollectionGap("malformed_tree");
  return text.split("\0").filter(Boolean).map((row) => {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40}(?:[a-f0-9]{24})?) +([0-9]+|-)\t([\s\S]+)$/.exec(row);
    if (!match || !sourcePath(match[5])) throw new CollectionGap("malformed_tree");
    const size = match[4] === "-" ? null : Number(match[4]);
    if (size !== null && !Number.isSafeInteger(size)) throw new CollectionGap("malformed_tree");
    return { mode: match[1], oid: match[3], size, path: match[5] };
  });
}

function snippet(text: string): { snippet: string; snippetTruncated: boolean } {
  let end = Math.min(text.length, LITERAL_CONTEXT_CAPS.snippetBytes);
  while (Buffer.byteLength(text.slice(0, end)) > LITERAL_CONTEXT_CAPS.snippetBytes
    || (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]))) end--;
  return { snippet: text.slice(0, end), snippetTruncated: end < text.length };
}

// The caller supplies changed anchors from its captured diff, never ambient WORKING labels.
export async function collectLiteralContext(input: {
  readonly snapshot: Pick<RunnerSandbox, "repoPath" | "expectedHeadSha" | "expectedBaseSha">;
  readonly seeds: readonly LiteralContextSeed[];
  readonly reviewDeadlineMs?: number;
  readonly abortSignal?: AbortSignal;
}): Promise<LiteralContextCollection> {
  const snapshot = { ...input.snapshot };
  const deadline = Math.min(performance.now() + LITERAL_CONTEXT_CAPS.milliseconds,
    input.reviewDeadlineMs ?? Infinity);
  const gaps = new Set<string>();
  const candidates: LiteralContextCandidate[] = [];
  let scannedBytes = 0;
  let scannedFiles = 0;
  let established = false;
  const result = (): LiteralContextCollection => {
    const collection = (): LiteralContextCollection => ({
      status: gaps.size === 0 ? "complete_literal_search" : established ? "partial" : "unknown",
      semanticStatus: "unknown", caps: LITERAL_CONTEXT_CAPS,
      scannedBytes, scannedFiles, gaps: [...gaps], candidates,
    });
    while (Buffer.byteLength(JSON.stringify(collection())) > LITERAL_CONTEXT_CAPS.jsonBytes && candidates.length > 0) {
      gaps.add("json_bytes_cap");
      candidates.pop();
    }
    return collection();
  };
  if (!path.isAbsolute(snapshot.repoPath) || snapshot.repoPath.includes("\0")
    || !fixedRevision(snapshot.expectedHeadSha) || snapshot.expectedBaseSha === undefined
    || !fixedRevision(snapshot.expectedBaseSha)) {
    gaps.add("unsupported_snapshot");
    return result();
  }
  if (input.seeds.length === 0 || input.seeds.length > LITERAL_CONTEXT_CAPS.seeds || input.seeds.some((seed) =>
    (seed.revision !== snapshot.expectedHeadSha && seed.revision !== snapshot.expectedBaseSha)
    || !sourcePath(seed.path) || !Number.isSafeInteger(seed.line) || seed.line < 1
    || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(seed.identifier)
    || Buffer.byteLength(seed.identifier) > LITERAL_CONTEXT_CAPS.identifierBytes)) {
    gaps.add("invalid_seed");
    return result();
  }
  const seeds = input.seeds.map((seed) => ({ ...seed }));
  const checkBudget = (): void => {
    if (input.abortSignal?.aborted) throw new CollectionGap("aborted");
    if (!Number.isFinite(deadline) || performance.now() >= deadline) throw new CollectionGap("deadline");
  };
  const git = async (args: readonly string[], cap: number): Promise<Buffer> => {
    checkBudget();
    let controller: ManagedRunnerProcessController | undefined;
    let failure: string | undefined;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const stop = (reason: string): void => {
      failure ??= reason;
      controller?.stop("SIGKILL");
    };
    const abort = (): void => stop("aborted");
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    try {
      const output = await runManagedRunnerProcess({
        command: "git",
        args: ["--no-replace-objects", "--no-pager", "--literal-pathspecs", `--git-dir=${path.join(snapshot.repoPath, ".git")}`,
          "-c", "core.fsmonitor=", "-c", "core.hooksPath=/dev/null",
          "-c", "core.attributesFile=/dev/null", "-c", "credential.helper=", "-c", "protocol.allow=never",
          ...args],
        repoPath: snapshot.repoPath,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/dev/null", LC_ALL: "C",
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
          GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
        timeoutMs: Math.max(1, Math.floor(deadline - performance.now())),
        onSpawn: (value) => {
          controller = value;
          // Latin-1 preserves every byte through the managed runner's string callbacks.
          value.child.stdout.setEncoding("latin1");
          value.child.stderr.setEncoding("latin1");
          value.endStdin();
          if (input.abortSignal?.aborted) abort();
        },
        onStdout: (chunk) => {
          bytes += chunk.length;
          if (bytes > cap) return stop("command_output_cap");
          chunks.push(Buffer.from(chunk, "latin1"));
        },
        onStderr: (chunk) => { bytes += chunk.length; if (bytes > cap) stop("command_output_cap"); },
        onTimeout: () => stop("deadline"),
      });
      if (failure !== undefined) throw new CollectionGap(failure);
      checkBudget();
      if (output.error || output.status !== 0) throw new CollectionGap("git_read_failed");
      return Buffer.concat(chunks);
    } finally {
      input.abortSignal?.removeEventListener("abort", abort);
    }
  };
  try {
    const trees = new Map<string, TreeEntry[]>();
    let treeBytes = 0;
    for (const revision of new Set([snapshot.expectedBaseSha, snapshot.expectedHeadSha])) {
      const kind = decode(await git(["cat-file", "-t", revision], 128)).trim();
      if (kind !== "commit") throw new CollectionGap("unsupported_snapshot");
      const tree = await git(["ls-tree", "-rlz", "--full-tree", revision, "--"], LITERAL_CONTEXT_CAPS.treeBytes - treeBytes);
      treeBytes += tree.length;
      trees.set(revision, treeEntries(tree));
    }
    const blobs = new Map<string, { text: string; sha256: string }>();
    const readBlob = async (entry: TreeEntry): Promise<{ text: string; sha256: string } | null> => {
      checkBudget();
      if (entry.mode !== "100644" && entry.mode !== "100755") { gaps.add("unsupported_entry"); return null; }
      if (entry.size === null) throw new CollectionGap("malformed_tree");
      if (entry.size > LITERAL_CONTEXT_CAPS.blobBytes) { gaps.add("blob_bytes_cap"); return null; }
      const cached = blobs.get(entry.oid);
      if (cached) return cached;
      if (scannedBytes + entry.size > LITERAL_CONTEXT_CAPS.scannedBytes) { gaps.add("scan_bytes_cap"); return null; }
      const bytes = await git(["cat-file", "blob", entry.oid], LITERAL_CONTEXT_CAPS.blobBytes);
      if (bytes.length !== entry.size) throw new CollectionGap("blob_size_mismatch");
      scannedBytes += bytes.length;
      if (bytes.includes(0)) { gaps.add("binary_blob"); return null; }
      let text: string;
      try { text = decode(bytes); } catch (error) {
        if (!(error instanceof CollectionGap)) throw error;
        gaps.add(error.message); return null;
      }
      const blob = { text, sha256: createHash("sha256").update(bytes).digest("hex") };
      blobs.set(entry.oid, blob);
      return blob;
    };
    const accepted: LiteralContextSeed[] = [];
    for (const seed of seeds) {
      const entry = trees.get(seed.revision)?.find((entry) => entry.path === seed.path);
      if (!entry) { gaps.add("anchor_missing"); continue; }
      const blob = await readBlob(entry);
      if (blob && blob.text.split("\n")[seed.line - 1]?.includes(seed.identifier)) accepted.push(seed);
      else gaps.add("anchor_unverified");
    }
    if (accepted.length === 0) return result();
    established = true;
    let files = 0;
    let hits = 0;
    for (const [revision, entries] of trees) {
      const selected = accepted.filter((seed) => seed.revision === revision);
      if (selected.length === 0) continue;
      for (const entry of entries) {
        checkBudget();
        if ((entry.mode === "100644" || entry.mode === "100755") && ++files > LITERAL_CONTEXT_CAPS.files) {
          gaps.add("file_count_cap"); break;
        }
        const blob = await readBlob(entry);
        if (!blob) continue;
        scannedFiles++;
        const lines = blob.text.split("\n");
        for (let at = 0; at < lines.length; at++) {
          for (const seed of selected) {
            if (!lines[at].includes(seed.identifier)) continue;
            if (hits++ >= LITERAL_CONTEXT_CAPS.hits) { gaps.add("hit_count_cap"); return result(); }
            candidates.push({ seed, revision, path: entry.path, line: at + 1,
              blobOid: entry.oid, contentSha256: blob.sha256, ...snippet(lines[at]),
              relationship: "unverified_literal", semanticStatus: "unknown" });
            result();
          }
        }
      }
    }
  } catch (error) {
    if (!(error instanceof CollectionGap)) throw error;
    gaps.add(error.message);
  }
  return result();
}
