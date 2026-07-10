import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ghText } from "../../src/shared/repo";
import type { FixtureProvenance } from "../shared/types";

const CAP_PER_FILE_BYTES = 50 * 1024;
const CAP_TOTAL_BYTES = 400 * 1024;

export type ProvenanceKind = FixtureProvenance["kind"];

const KINDS: readonly ProvenanceKind[] = ["review-finding", "post-merge-fix", "revert", "clean-negative"];

export interface CliArgs {
  readonly repo: string;
  readonly pr: number;
  readonly out: string;
  readonly kind: ProvenanceKind;
  readonly force: boolean;
}

const USAGE = `Usage: npx tsx eval/tools/pr2fixture.ts --repo owner/name --pr N --out eval/fixtures-real/<slug>/ --kind <kind> [--force]

Fetches a GitHub PR's changed files (base + head contents via gh api) and writes
a FixtureSpec skeleton to <out>/spec.ts for a human curator to fill in.

  --repo   owner/name (required)
  --pr     PR number, positive integer (required)
  --out    output directory, e.g. eval/fixtures-real/my-slug/ (required)
  --kind   review-finding | post-merge-fix | revert | clean-negative (required)
  --force  overwrite an existing spec.ts
  --help   print this message and exit
`;

// Pure arg parsing/validation — no I/O, no network. Throws on invalid input.
export function parseCliArgs(argv: readonly string[]): CliArgs | { readonly help: true } {
  if (argv.includes("--help")) return { help: true };
  const get = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] ?? null : null;
  };
  const repo = get("--repo");
  if (!repo) throw new Error("--repo is required (owner/name)");
  const prRaw = get("--pr");
  if (!prRaw) throw new Error("--pr is required");
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr < 1) throw new Error(`--pr must be a positive integer, got: ${prRaw}`);
  const out = get("--out");
  if (!out) throw new Error("--out is required");
  const kindRaw = get("--kind");
  if (!kindRaw) throw new Error("--kind is required");
  if (!KINDS.includes(kindRaw as ProvenanceKind)) {
    throw new Error(`--kind must be one of ${KINDS.join("|")}, got: ${kindRaw}`);
  }
  const force = argv.includes("--force");
  return { repo, pr, out, kind: kindRaw as ProvenanceKind, force };
}

// slug = final path segment of --out, validated kebab-case. Used as the
// fixture id.
export function deriveSlug(outDir: string): string {
  const normalized = outDir.replace(/\/+$/, "");
  const slug = path.basename(normalized);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) {
    throw new Error(`--out's final path segment must be kebab-case (lowercase letters, digits, hyphens), got: "${slug}"`);
  }
  return slug;
}

export function mapKind(kind: ProvenanceKind): "positive" | "negative" {
  return kind === "clean-negative" ? "negative" : "positive";
}

export interface CapCheckFile {
  readonly path: string;
  readonly bytes: number;
}

export function checkCaps(files: readonly CapCheckFile[]): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  const tooBig = files.find((f) => f.bytes > CAP_PER_FILE_BYTES);
  if (tooBig) {
    return { ok: false, error: `${tooBig.path} is ${tooBig.bytes} bytes, exceeds the per-file cap of ${CAP_PER_FILE_BYTES} bytes` };
  }
  const total = files.reduce((sum, f) => sum + f.bytes, 0);
  if (total > CAP_TOTAL_BYTES) {
    return { ok: false, error: `total changed content is ${total} bytes, exceeds the total cap of ${CAP_TOTAL_BYTES} bytes` };
  }
  return { ok: true };
}

export function checkOverwrite(outDir: string, force: boolean): void {
  const specPath = path.join(outDir, "spec.ts");
  if (existsSync(specPath) && !force) {
    throw new Error(`${specPath} already exists; pass --force to overwrite`);
  }
}

export function isBinaryContent(buf: Buffer): boolean {
  const window = buf.subarray(0, Math.min(buf.length, 8000));
  return window.includes(0);
}

export interface SpecSkeletonInput {
  readonly id: string;
  readonly kind: "positive" | "negative";
  readonly provenance: FixtureProvenance;
  readonly prTitle: string;
  readonly prUrl: string;
  readonly baseFiles: Readonly<Record<string, string>>;
  readonly deletedFiles: readonly string[];
  readonly headFiles: Readonly<Record<string, string>>;
}

const CURATOR_HEADER = `// GENERATED SKELETON by eval/tools/pr2fixture.ts — DO NOT ship as-is.
// A human curator MUST replace every TODO-CURATOR placeholder using the
// evidence from the PR's review thread (provenance.evidenceUrl), never from
// the PR's code diff itself: mustFind/mustNotFind patterns are the eval's
// answer key, and an answer key derived from the code it's grading is
// cheat-proof-broken by construction. Also add anchorFile/anchorLineRange
// once the defect location is confirmed.
`;

function fileRecordSource(files: Readonly<Record<string, string>>): string {
  const entries = Object.entries(files).map(([file, content]) => `    ${JSON.stringify(file)}: ${JSON.stringify(content)},`);
  return `{\n${entries.join("\n")}\n  }`;
}

function provenanceSource(p: FixtureProvenance): string {
  const parts = [
    `repo: ${JSON.stringify(p.repo)}`,
    `pr: ${p.pr}`,
    `kind: ${JSON.stringify(p.kind)}`,
  ];
  if (p.evidenceUrl) parts.push(`evidenceUrl: ${JSON.stringify(p.evidenceUrl)}`);
  if (p.fixSha) parts.push(`fixSha: ${JSON.stringify(p.fixSha)}`);
  return `{ ${parts.join(", ")} }`;
}

// Pure string builder — no file I/O. Emits the literal spec.ts source text.
export function buildSpecSource(input: SpecSkeletonInput): string {
  const description = `TODO-CURATOR: describe the defect and where it lives. Source: ${input.prUrl} — "${input.prTitle}".`;
  const expected =
    input.kind === "positive"
      ? `{
    verdict: "changes_requested",
    mustFind: [{ pattern: "TODO-CURATOR-PATTERN" }],
  }`
      : `{
    verdict: "pass",
    noBlockingFindings: true,
  }`;
  const tierLine = input.kind === "positive" ? `\n  tier: 2, // TODO-CURATOR: confirm difficulty tier 1|2|3` : "";
  return `${CURATOR_HEADER}import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: ${JSON.stringify(input.id)},
  kind: ${JSON.stringify(input.kind)},${tierLine}
  defectClass: "TODO-CURATOR-DEFECT-CLASS",
  description: ${JSON.stringify(description)},
  baseFiles: ${fileRecordSource(input.baseFiles)},
${input.deletedFiles.length > 0 ? `  deletedFiles: ${JSON.stringify(input.deletedFiles)},\n` : ""}  headFiles: ${fileRecordSource(input.headFiles)},
  expected: ${expected},
  provenance: ${provenanceSource(input.provenance)},
};

export default spec;
`;
}

// --- I/O below: gh fetch, decoding, writing. Not unit tested (network). ---

interface PrFile {
  readonly filename: string;
  readonly status: string;
  readonly previousFilename?: string;
}

function assertRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${what} to be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function fetchPrMeta(repo: string, pr: number): { baseSha: string; headSha: string; title: string; url: string } {
  const raw: unknown = JSON.parse(ghText(["api", `repos/${repo}/pulls/${pr}`]));
  const obj = assertRecord(raw, "PR response");
  const base = assertRecord(obj.base, "PR response.base");
  const head = assertRecord(obj.head, "PR response.head");
  const baseSha = base.sha;
  const headSha = head.sha;
  const title = obj.title;
  const url = obj.html_url;
  if (typeof baseSha !== "string" || typeof headSha !== "string" || typeof title !== "string" || typeof url !== "string") {
    throw new Error("PR response missing base.sha/head.sha/title/html_url");
  }
  return { baseSha, headSha, title, url };
}

function fetchPrFiles(repo: string, pr: number): PrFile[] {
  const raw: unknown = JSON.parse(ghText(["api", `repos/${repo}/pulls/${pr}/files`, "--paginate", "--slurp"]));
  if (!Array.isArray(raw)) throw new Error("expected PR files response to be a JSON array");
  const entries: unknown[] = raw.every(Array.isArray) ? raw.flat() : raw;
  return entries.map((entry) => {
    const obj = assertRecord(entry, "PR file entry");
    if (typeof obj.filename !== "string" || typeof obj.status !== "string") {
      throw new Error("PR file entry missing filename/status");
    }
    if (obj.status === "renamed") {
      if (typeof obj.previous_filename !== "string") {
        throw new Error("renamed PR file entry missing previous_filename");
      }
      return { filename: obj.filename, status: obj.status, previousFilename: obj.previous_filename };
    }
    return { filename: obj.filename, status: obj.status };
  });
}

function encodePath(filename: string): string {
  return filename.split("/").map(encodeURIComponent).join("/");
}

// Returns the file's decoded content, or null when it is binary (skipped).
function fetchFileContent(repo: string, filename: string, ref: string): Buffer | null {
  const raw: unknown = JSON.parse(ghText(["api", `repos/${repo}/contents/${encodePath(filename)}?ref=${ref}`]));
  const obj = assertRecord(raw, "contents response");
  if (obj.type === "symlink" || obj.type === "submodule") {
    console.warn(`skipping ${obj.type}: ${filename}`);
    return null;
  }
  if (obj.type !== "file") {
    throw new Error(`unexpected contents type for ${filename}@${ref}`);
  }
  if (obj.encoding !== "base64" || typeof obj.content !== "string") {
    throw new Error(`unexpected contents encoding for ${filename}@${ref}`);
  }
  const buf = Buffer.from(obj.content.replace(/\n/g, ""), "base64");
  if (isBinaryContent(buf)) {
    console.warn(`skipping binary file: ${filename}`);
    return null;
  }
  return buf;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const parsed = parseCliArgs(argv);
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return;
  }
  const { repo, pr, out, kind, force } = parsed;
  const id = deriveSlug(out);
  checkOverwrite(out, force);

  const prMeta = fetchPrMeta(repo, pr);
  const files = fetchPrFiles(repo, pr);

  const baseFiles: Record<string, string> = {};
  const deletedFiles: string[] = [];
  const headFiles: Record<string, string> = {};
  const capFiles: CapCheckFile[] = [];

  for (const file of files) {
    const baseFilename = file.previousFilename ?? file.filename;
    const baseBuf = file.status === "added" ? null : fetchFileContent(repo, baseFilename, prMeta.baseSha);
    const headBuf = file.status === "removed" ? null : fetchFileContent(repo, file.filename, prMeta.headSha);

    if ((file.status !== "added" && baseBuf === null) || (file.status !== "removed" && headBuf === null)) continue;

    if (baseBuf !== null) {
      baseFiles[baseFilename] = baseBuf.toString("utf8");
      capFiles.push({ path: `${baseFilename} (base)`, bytes: baseBuf.length });
    }
    if (headBuf !== null) {
      headFiles[file.filename] = headBuf.toString("utf8");
      capFiles.push({ path: `${file.filename} (head)`, bytes: headBuf.length });
    }
    if (file.status === "removed") {
      deletedFiles.push(file.filename);
    } else if (file.status === "renamed") {
      deletedFiles.push(baseFilename);
    }
  }

  if (capFiles.length === 0) {
    throw new Error("PR has no reviewable text files");
  }

  const capResult = checkCaps(capFiles);
  if (!capResult.ok) {
    process.stderr.write(`pr2fixture: ${capResult.error}\n`);
    process.exit(1);
  }

  const provenance: FixtureProvenance = { repo, pr, kind, evidenceUrl: prMeta.url };
  const source = buildSpecSource({
    id,
    kind: mapKind(kind),
    provenance,
    prTitle: prMeta.title,
    prUrl: prMeta.url,
    baseFiles,
    deletedFiles,
    headFiles,
  });

  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "spec.ts"), source);
  const totalBytes = capFiles.reduce((sum, f) => sum + f.bytes, 0);
  process.stdout.write(
    `pr2fixture: wrote ${path.join(out, "spec.ts")} (${capFiles.length} file-sides, ${totalBytes} bytes)\n`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    process.stderr.write(`pr2fixture failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
