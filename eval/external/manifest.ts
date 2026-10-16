import Ajv from "ajv";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TextDecoder } from "node:util";

type RecordedSource = {
  datasetId: "martian" | "swrbench";
  datasetRevision: string;
  sourceURL: string;
  sourceBytes: { scope: "full" | "slice"; sha256: string; byteLength: number; rangeStart: number | null };
  instanceId: string;
  canonicalRepo: string;
  originalURL: string;
  datasetLicense: { spdx: "MIT"; noticeSHA256: string };
  upstreamCodeLicense: "unknown";
};
type Snapshot = {
  sourceBaseSHA: string;
  reviewHeadSHA: string;
  observedFinalHeadSHA: string | null;
} & ({
  kind: "metadata-only";
  reviewBaseSHA: string | null;
  mergeBaseSHA: string | null;
  reasons: string[];
} | {
  kind: "frozen";
  reviewBaseSHA: string;
  mergeBaseSHA: string;
  commitSHAs: string[];
  baseTreeSHA: string;
  headTreeSHA: string;
  diffSHA256: string;
});
export type ExternalManifest = {
  schemaVersion: 1;
  source: RecordedSource;
  snapshot: Snapshot;
  reviewText: { kind: "unknown"; reason: string } | {
    kind: "frozen"; title: string; description: string; policy: string;
    titleSHA256: string; descriptionSHA256: string; policySHA256: string;
  };
  evaluator: { label: "positive" | "clean" | "unknown"; goldCount: number; goldLocations: "missing"; provenance: string };
};

const sha = { type: "string", pattern: "^[a-f0-9]{40}$" };
const hash = { type: "string", pattern: "^[a-f0-9]{64}$" };
const text = { type: "string", maxLength: 100_000 };
const nonempty = { type: "string", minLength: 1, maxLength: 2000 };
const url = { type: "string", pattern: "^https://[^\\s]+$", maxLength: 2000 };
function object(properties: Record<string, unknown>) {
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties };
}
const commonSnapshot = { sourceBaseSHA: sha, reviewHeadSHA: sha, observedFinalHeadSHA: { anyOf: [sha, { type: "null" }] } };
const ajv = new Ajv({ strict: true, allErrors: true });
const validate = ajv.compile<ExternalManifest>(object({
  schemaVersion: { const: 1 },
  source: object({
    datasetId: { enum: ["martian", "swrbench"] }, datasetRevision: sha, sourceURL: url,
    sourceBytes: object({ scope: { enum: ["full", "slice"] }, sha256: hash, byteLength: { type: "integer", minimum: 1, maximum: 200_000 }, rangeStart: { anyOf: [{ type: "integer", minimum: 0 }, { type: "null" }] } }),
    instanceId: { type: "string", pattern: "^[a-zA-Z0-9._-]+$", maxLength: 200 },
    canonicalRepo: { type: "string", pattern: "^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$", maxLength: 200 },
    originalURL: url, datasetLicense: object({ spdx: { const: "MIT" }, noticeSHA256: hash }), upstreamCodeLicense: { const: "unknown" },
  }),
  snapshot: { oneOf: [
    object({ ...commonSnapshot, kind: { const: "metadata-only" }, reviewBaseSHA: { anyOf: [sha, { type: "null" }] }, mergeBaseSHA: { anyOf: [sha, { type: "null" }] }, reasons: { type: "array", minItems: 1, maxItems: 20, items: nonempty } }),
    object({ ...commonSnapshot, kind: { const: "frozen" }, reviewBaseSHA: sha, mergeBaseSHA: sha, commitSHAs: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true, items: sha }, baseTreeSHA: sha, headTreeSHA: sha, diffSHA256: hash }),
  ] },
  reviewText: { oneOf: [
    object({ kind: { const: "unknown" }, reason: nonempty }),
    object({ kind: { const: "frozen" }, title: text, description: text, policy: text, titleSHA256: hash, descriptionSHA256: hash, policySHA256: hash }),
  ] },
  evaluator: object({ label: { enum: ["positive", "clean", "unknown"] }, goldCount: { type: "integer", minimum: 0, maximum: 10_000 }, goldLocations: { const: "missing" }, provenance: nonempty }),
}));
export function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
export const maxManifestBytes = 250_000;
export function parseManifest(bytes: string): ExternalManifest {
  if (Buffer.byteLength(bytes) > maxManifestBytes) throw new Error("manifest_too_large");
  const value: unknown = JSON.parse(bytes);
  if (!validate(value)) throw new Error(`invalid_manifest: ${ajv.errorsText(validate.errors)}`);
  if ((value.source.sourceBytes.scope === "full") !== (value.source.sourceBytes.rangeStart === null)) throw new Error("invalid_source_byte_scope");
  if (value.evaluator.label === "clean" && value.evaluator.goldCount !== 0) throw new Error("clean_with_gold");
  if (value.evaluator.label === "positive" && value.evaluator.goldCount === 0) throw new Error("positive_without_gold");
  return value;
}

type CodeFile = { path: string; mode: string; content: string };
type LineRange = { path: string; oldStart: number; oldLines: number; newStart: number; newLines: number };
export type ReviewerInput = {
  schemaVersion: 1;
  title: string;
  description: string;
  policy: string;
  snapshot: { baseSHA: string; headSHA: string; baseTreeSHA: string; headTreeSHA: string; diffSHA256: string };
  baseFiles: CodeFile[];
  headFiles: CodeFile[];
  diff: string;
  lineMap: LineRange[];
};
export type ImportResult = {
  status: "excluded"; reasons: string[];
} | {
  status: "source-ready"; reviewer: ReviewerInput;
};

const maxBytes = 8 * 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
type GitObjects = { directory: string; objects?: string };
function git(repo: GitObjects, args: string[]): Buffer {
  const result = spawnSync("git", ["--no-replace-objects", "--no-optional-locks", "--no-pager", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", repo.directory, ...args], {
    env: { PATH: process.env.PATH, HOME: "/nonexistent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_OBJECT_DIRECTORY: repo.objects },
    timeout: 5000, maxBuffer: maxBytes,
  });
  if (result.status !== 0 || result.error) throw new Error("missing_object_or_git_limit");
  return result.stdout;
}
function utf8(bytes: Buffer): string {
  if (bytes.includes(0)) throw new Error("unsupported_binary");
  try { return decoder.decode(bytes); } catch { throw new Error("unsupported_non_utf8"); }
}
function gitText(repo: GitObjects, args: string[]): string { return utf8(git(repo, args)).trimEnd(); }
function checkEqual(actual: string, expected: string, reason: string): void {
  if (actual !== expected) throw new Error(reason);
}
function treeFiles(repo: GitObjects, tree: string): CodeFile[] {
  const entries = git(repo, ["ls-tree", "-r", "-z", tree]).toString("utf8").split("\0").filter(Boolean);
  if (entries.length > 1000) throw new Error("snapshot_file_limit");
  let total = 0;
  return entries.map((entry) => {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([a-zA-Z0-9._/@+-]+)$/.exec(entry);
    if (!match) throw new Error("unsupported_path_or_file_mode");
    const bytes = git(repo, ["cat-file", "blob", match[2]]);
    total += bytes.length;
    if (total > maxBytes) throw new Error("snapshot_byte_limit");
    return { path: match[3], mode: match[1], content: utf8(bytes) };
  });
}
const diffArgs = ["diff", "--full-index", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--no-color", "--diff-algorithm=myers", "--no-indent-heuristic", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3"];
export function importManifest(manifest: ExternalManifest, repo?: string): ImportResult {
  if (manifest.snapshot.kind === "metadata-only") return { status: "excluded", reasons: manifest.snapshot.reasons };
  if (manifest.reviewText.kind === "unknown") return { status: "excluded", reasons: [manifest.reviewText.reason] };
  if (!repo) return { status: "excluded", reasons: ["local_objects_not_checked"] };
  const snapshot = manifest.snapshot;
  const reviewText = manifest.reviewText;
  let temporary: string | undefined;
  try {
    const sourceRepo = { directory: repo };
    const config = git(sourceRepo, ["config", "--list", "--null"]).toString("utf8");
    if (/(?:^|\0)(?:extensions\.partialclone|remote\.[^\0\n]+\.promisor)\n/i.test(config)) throw new Error("unsupported_partial_clone");
    const objects = realpathSync(resolve(repo, gitText(sourceRepo, ["rev-parse", "--git-path", "objects"])));
    temporary = mkdtempSync(join(tmpdir(), "needlefish-external-objects-"));
    mkdirSync(join(temporary, "objects"));
    mkdirSync(join(temporary, "refs"));
    writeFileSync(join(temporary, "HEAD"), "ref: refs/heads/unused\n");
    writeFileSync(join(temporary, "config"), "[core]\n bare = true\n repositoryformatversion = 0\n attributesFile = /dev/null\n");
    const view = { directory: temporary, objects };
    for (const key of ["title", "description", "policy"] as const) {
      checkEqual(sha256(reviewText[key]), reviewText[`${key}SHA256`], `${key}_hash_mismatch`);
    }
    for (const commit of [snapshot.sourceBaseSHA, snapshot.reviewBaseSHA, snapshot.reviewHeadSHA]) {
      checkEqual(gitText(view, ["rev-parse", `${commit}^{commit}`]), commit, "wrong_commit_object");
    }
    let parent = snapshot.reviewBaseSHA;
    for (const commit of snapshot.commitSHAs) {
      const headers = gitText(view, ["cat-file", "commit", commit]).split("\n\n", 1)[0];
      const parents = headers.split("\n").filter((line) => line.startsWith("parent ")).map((line) => line.slice(7));
      checkEqual(parents.join(" "), parent, "unexpected_parent_dag");
      parent = commit;
    }
    checkEqual(parent, snapshot.reviewHeadSHA, "dataset_head_mismatch");
    checkEqual(gitText(view, ["rev-list", "--reverse", `${snapshot.reviewBaseSHA}..${snapshot.reviewHeadSHA}`]), snapshot.commitSHAs.join("\n"), "unexpected_commit_series");
    checkEqual(gitText(view, ["merge-base", snapshot.sourceBaseSHA, snapshot.reviewHeadSHA]), snapshot.mergeBaseSHA, "source_merge_base_mismatch");
    checkEqual(gitText(view, ["rev-parse", `${snapshot.reviewBaseSHA}^{tree}`]), snapshot.baseTreeSHA, "base_tree_mismatch");
    checkEqual(gitText(view, ["rev-parse", `${snapshot.reviewHeadSHA}^{tree}`]), snapshot.headTreeSHA, "head_tree_mismatch");
    const baseFiles = treeFiles(view, snapshot.baseTreeSHA);
    const headFiles = treeFiles(view, snapshot.headTreeSHA);
    const diff = utf8(git(view, [...diffArgs, snapshot.reviewBaseSHA, snapshot.reviewHeadSHA, "--"]));
    if (!diff) throw new Error("empty_diff");
    checkEqual(sha256(diff), snapshot.diffSHA256, "diff_hash_mismatch_or_truncated_patch");
    const paths = git(view, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", snapshot.reviewBaseSHA, snapshot.reviewHeadSHA, "--"]).toString("utf8").split("\0").filter(Boolean);
    if (paths.length > 100) throw new Error("changed_file_limit");
    const lineMap: LineRange[] = [];
    for (const path of paths) {
      const patch = utf8(git(view, [...diffArgs, snapshot.reviewBaseSHA, snapshot.reviewHeadSHA, "--", path]));
      for (const match of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
        lineMap.push({ path, oldStart: Number(match[1]), oldLines: Number(match[2] ?? 1), newStart: Number(match[3]), newLines: Number(match[4] ?? 1) });
      }
    }
    return { status: "source-ready", reviewer: {
      schemaVersion: 1, title: reviewText.title, description: reviewText.description, policy: reviewText.policy,
      snapshot: { baseSHA: snapshot.reviewBaseSHA, headSHA: snapshot.reviewHeadSHA, baseTreeSHA: snapshot.baseTreeSHA, headTreeSHA: snapshot.headTreeSHA, diffSHA256: snapshot.diffSHA256 },
      baseFiles, headFiles, diff, lineMap,
    } };
  } catch (error) {
    return { status: "excluded", reasons: [error instanceof Error ? error.message : "snapshot_verification_failed"] };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
export function evaluatorMetadata(manifest: ExternalManifest, result: ImportResult) {
  return {
    schemaVersion: 1, source: manifest.source, snapshot: manifest.snapshot, evaluator: manifest.evaluator,
    importStatus: result.status, exclusionReasons: result.status === "excluded" ? result.reasons : [],
    sourceProvenanceStatus: "recorded_metadata_not_reauthenticated",
    scoringStatus: "unscorable", scoringReasons: ["common_rubric_not_frozen", ...(manifest.evaluator.label === "positive" ? ["gold_locations_missing"] : [])],
    unmatchedFindingPolicy: "requires_blind_adjudication_not_automatic_false_positive", comparisonStatus: "NOT_RUN",
  };
}
