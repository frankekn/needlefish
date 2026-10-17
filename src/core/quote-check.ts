import { createHash } from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { Bundle, Finding, SourceEvidence } from "../shared/schema.js";

// A quote this short ("}", "return x;") matches too many lines to say
// anything about where a finding belongs.
const MIN_QUOTE_CHARS = 8;

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function gitRead(repoPath: string, args: readonly string[], deadlineMs?: number, allowNoMatch = false): Buffer | null {
	const timeout = Math.floor(Math.min(10_000, deadlineMs === undefined ? 10_000 : deadlineMs - performance.now()));
	if (timeout <= 0) return null;
	const res = spawnSync("git", ["--no-replace-objects", ...args], { cwd: repoPath, maxBuffer: 1024 * 1024 * 16, timeout });
	if (res.error || (res.status !== 0 && !(allowNoMatch && res.status === 1))) return null;
	if (deadlineMs !== undefined && performance.now() >= deadlineMs) return null;
	return res.stdout;
}

function gitOutput(repoPath: string, args: readonly string[], deadlineMs?: number, allowNoMatch = false): string | null {
	return gitRead(repoPath, args, deadlineMs, allowNoMatch)?.toString("utf8") ?? null;
}

// Fixed-string search of one tree. null means git failed (unknown ref, such as
// the uncommitted-mode WORKING sentinel), which leaves the finding unchecked;
// exit 1 is git grep's "no match".
function grepAt(repoPath: string, ref: string, quote: string, deadlineMs?: number): Hit[] | null {
	// spawnSync throws, rather than fails, on a NUL in model output.
	if (quote.includes("\0")) return null;
	const out = gitOutput(repoPath,
		["--literal-pathspecs", "grep", "-F", "-n", "-z", "-I", "--no-color", "--no-textconv", "-e", quote, ref, "--"],
		deadlineMs, true,
	);
	if (out === null) return null;
	// Each hit is "<ref>:<path>\0<line>\0<text>\n"; the path is verbatim and may
	// hold any byte but NUL, so split on NUL first, never on newline.
	const hits: Hit[] = [];
	const prefix = `${ref}:`;
	let at = 0;
	while (at < out.length) {
		const pathEnd = out.indexOf("\0", at);
		const lineEnd = pathEnd < 0 ? -1 : out.indexOf("\0", pathEnd + 1);
		const textEnd = lineEnd < 0 ? -1 : out.indexOf("\n", lineEnd + 1);
		if (textEnd < 0) return null;
		const rawPath = out.slice(at, pathEnd);
		if (!rawPath.startsWith(prefix)) return null;
		hits.push({
			file: rawPath.slice(prefix.length),
			line: Number(out.slice(pathEnd + 1, lineEnd)),
			text: out.slice(lineEnd + 1, textEnd),
		});
		at = textEnd + 1;
	}
	return hits;
}

function isChangedLine(bundle: Bundle, hit: Hit, deadlineMs?: number): boolean | null {
	const out = gitOutput(bundle.repoPath,
		["--literal-pathspecs", "diff", "--follow", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0", "--inter-hunk-context=0", bundle.baseSha, bundle.headSha, "--", hit.file],
		deadlineMs,
	);
	if (out === null) return null;
	return out.split("\n").some((line) => {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
		if (!hunk) return false;
		const start = Number(hunk[1]);
		const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
		return hit.line >= start && hit.line < start + count;
	});
}

function basePath(bundle: Bundle, file: string, deadlineMs?: number): string | null {
	const out = gitOutput(bundle.repoPath,
		["--literal-pathspecs", "diff", "--follow", "--name-status", "-z", "--no-ext-diff", "--no-textconv", bundle.baseSha, bundle.headSha, "--", file],
		deadlineMs,
	);
	if (out === null) return null;
	const fields = out.split("\0");
	return /^R\d+$/.test(fields[0]) && fields.length === 4 && fields[2] === file ? fields[1] : file;
}

function safePath(file: string): boolean {
	return !!file && !/[\\\0]/.test(file) && !path.posix.isAbsolute(file) &&
		!path.win32.isAbsolute(file) && !file.split("/").some((part) => part === "." || part === ".." || !part);
}

function fixedRevision(revision: string): boolean {
	return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(revision);
}

type GitEvidence = Extract<SourceEvidence, { sourceType: "git_blob" }>;

function unverifiedSource(finding: Finding, revision: string): GitEvidence {
	return { sourceType: "git_blob", revision: fixedRevision(revision) ? revision : null, file: finding.file,
		lineStart: finding.lineStart, lineEnd: finding.lineEnd, status: "source_unverified" };
}

// null means the Git read failed; absent files and mismatched quotes are unverified.
function sourceAt(finding: Finding, repoPath: string, revision: string, deadlineMs?: number): GitEvidence | null {
	if (!fixedRevision(revision)) return null;
	const unverified = unverifiedSource(finding, revision);
	if (!safePath(finding.file) || !finding.quote ||
		!Number.isInteger(finding.lineStart) || !Number.isInteger(finding.lineEnd)) return unverified;
	const entry = gitOutput(repoPath, ["--literal-pathspecs", "ls-tree", "-z", revision, "--", finding.file], deadlineMs);
	if (entry === null) return null;
	// A symlink is a blob too, but its text is a target path, not source code.
	const match = /^(100644|100755) blob ([a-f0-9]+)\t/.exec(entry);
	if (!match) return unverified;
	const blob = gitRead(repoPath, ["cat-file", "blob", match[2]], deadlineMs);
	if (blob === null) return null;
	const lines = blob.toString("utf8").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (finding.lineStart < 1 || finding.lineEnd < finding.lineStart || finding.lineEnd > lines.length ||
		lines[finding.lineStart - 1]?.trim() !== finding.quote.trim()) return unverified;
	return { ...unverified, revision, status: "source_present",
		contentDigest: createHash("sha256").update(blob).digest("hex") };
}

function withSource(finding: Finding, source: GitEvidence): Finding {
	return { ...finding, evidence: { toolRead: "unknown", sources: [source] } };
}

function checkOne(finding: Finding, bundle: Bundle, changed: ReadonlySet<string>, deadlineMs?: number): Finding {
	const quote = finding.quote?.trim();
	if (!quote) return { ...finding, replacement: undefined };
	const unchecked: Finding = { ...finding, replacement: undefined, quoteCheck: { status: "unchecked" } };
	if (!safePath(finding.file) || !fixedRevision(bundle.headSha) || !fixedRevision(bundle.baseSha) ||
		!Number.isInteger(finding.lineStart) || !Number.isInteger(finding.lineEnd) ||
		quote.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return unchecked;
	const head = sourceAt(finding, bundle.repoPath, bundle.headSha, deadlineMs);
	if (!head) return unchecked;
	if (head.status === "source_present") return withSource({ ...finding, quoteCheck: { status: "matched" } }, head);
	const headHits = grepAt(bundle.repoPath, bundle.headSha, quote, deadlineMs);
	if (!headHits) return unchecked;
	const wholeHits = headHits.filter((hit) => hit.text.trim() === quote);
	const [hit] = wholeHits;
	if (wholeHits.length === 1 && changed.has(hit.file)) {
		const changedLine = isChangedLine(bundle, hit, deadlineMs);
		if (changedLine === null) return unchecked;
		if (changedLine) {
			const relocated: Finding = {
				...finding,
				file: hit.file,
				lineStart: hit.line,
				lineEnd: hit.line,
				replacement: undefined,
				quoteCheck: { status: "moved", from: `${finding.file}:${finding.lineStart}` },
			};
			const source = sourceAt(relocated, bundle.repoPath, bundle.headSha, deadlineMs);
			return source?.status === "source_present" ? withSource(relocated, source) : unchecked;
		}
	}
	// A BASE match cannot verify the finding's HEAD coordinates.
	const oldPath = basePath(bundle, finding.file, deadlineMs);
	if (oldPath === null) return unchecked;
	const base = sourceAt({ ...finding, file: oldPath }, bundle.repoPath, bundle.baseSha, deadlineMs);
	if (!base) return unchecked;
	if (base.status === "source_present") return withSource(unchecked, base);
	return { ...finding, replacement: undefined, quoteCheck: { status: "not_found" } };
}

// Annotates and, on one unique changed-line match, relocates findings. It
// never drops a finding or changes severity, so it cannot move the verdict.
export function checkQuotes(findings: readonly Finding[], bundle: Bundle, deadlineMs?: number): Finding[] {
	const changed = new Set(bundle.changedFiles.map((file) => file.path));
	const quoteDeadline = deadlineMs ?? performance.now() + 10_000;
	return findings.map((finding) => {
		const checked = checkOne({ ...finding, evidence: undefined }, bundle, changed, quoteDeadline);
		return { ...checked, evidence: { toolRead: "unknown", sources: [checked.evidence?.sources[0] ?? unverifiedSource(checked, bundle.headSha),
			...(finding.externalClaims ?? []).map((claim): SourceEvidence => ({ ...claim, sourceType: "external", status: "unverified_external_claim" }))] } };
	});
}
