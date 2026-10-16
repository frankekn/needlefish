import { spawnSync } from "node:child_process";
import type { Bundle, Finding } from "../shared/schema.js";

// A quote this short ("}", "return x;") matches too many lines to say
// anything about where a finding belongs.
const MIN_QUOTE_CHARS = 8;

interface Hit {
	readonly file: string;
	readonly line: number;
	readonly text: string;
}

function gitOutput(repoPath: string, args: readonly string[], deadlineMs?: number, allowNoMatch = false): string | null {
	const timeout = Math.floor(Math.min(10_000, deadlineMs === undefined ? 10_000 : deadlineMs - performance.now()));
	if (timeout <= 0) return null;
	const res = spawnSync("git", args, { cwd: repoPath, encoding: "utf8", maxBuffer: 1024 * 1024 * 16, timeout });
	if (res.error || (res.status !== 0 && !(allowNoMatch && res.status === 1))) return null;
	if (deadlineMs !== undefined && performance.now() >= deadlineMs) return null;
	return res.stdout;
}

// Fixed-string search of one tree. null means verification failed;
// exit 1 is git grep's "no match".
function grepAt(repoPath: string, ref: string, quote: string, file: string | undefined, deadlineMs?: number): Hit[] | null {
	// spawnSync throws, rather than fails, on a NUL in argv; file is model output.
	if (quote.includes("\0") || file?.includes("\0")) return null;
	const out = gitOutput(repoPath,
		// The cited file is model output: match it as a literal path, never a
		// glob or pathspec magic such as `*` or `:(top)`.
		["--literal-pathspecs", "grep", "-F", "-n", "-z", "-I", "--no-color", "--no-textconv", "-e", quote, ref, "--", ...(file ? [file] : [])],
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

function checkOne(finding: Finding, bundle: Bundle, changed: ReadonlySet<string>, deadlineMs?: number): Finding {
	const quote = finding.quote?.trim();
	if (!quote) return finding;
	const unchecked: Finding = { ...finding, replacement: undefined, quoteCheck: { status: "unchecked" } };
	if (bundle.headSha === "WORKING" || quote.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return unchecked;
	const citedHits = grepAt(bundle.repoPath, bundle.headSha, quote, finding.file, deadlineMs);
	if (!citedHits) return unchecked;
	const atLocation = (hit: Hit) => hit.text.trim() === quote && hit.line === finding.lineStart;
	if (citedHits.some(atLocation)) return { ...finding, quoteCheck: { status: "matched" } };
	// Removed source can validate a finding, but never a replacement of head lines.
	const oldPath = basePath(bundle, finding.file, deadlineMs);
	if (oldPath === null) return unchecked;
	const baseHits = grepAt(bundle.repoPath, bundle.baseSha, quote, oldPath, deadlineMs);
	if (!baseHits) return unchecked;
	if (baseHits.some(atLocation)) return { ...finding, replacement: undefined, quoteCheck: { status: "matched" } };
	const headHits = grepAt(bundle.repoPath, bundle.headSha, quote, undefined, deadlineMs);
	if (!headHits) return unchecked;
	const wholeHits = headHits.filter((hit) => hit.text.trim() === quote);
	const [hit] = wholeHits;
	if (wholeHits.length === 1 && changed.has(hit.file)) {
		const changedLine = isChangedLine(bundle, hit, deadlineMs);
		if (changedLine === null) return unchecked;
		if (!changedLine) return { ...finding, replacement: undefined, quoteCheck: { status: "not_found" } };
		return {
			...finding,
			file: hit.file,
			lineStart: hit.line,
			lineEnd: hit.line,
			replacement: undefined,
			quoteCheck: { status: "moved", from: `${finding.file}:${finding.lineStart}` },
		};
	}
	return { ...finding, replacement: undefined, quoteCheck: { status: "not_found" } };
}

// Annotates and, on one unique changed-line match, relocates findings. It
// never drops a finding or changes severity, so it cannot move the verdict.
export function checkQuotes(findings: readonly Finding[], bundle: Bundle, deadlineMs?: number): Finding[] {
	const changed = new Set(bundle.changedFiles.map((file) => file.path));
	return findings.map((finding) => checkOne(finding, bundle, changed, deadlineMs));
}
