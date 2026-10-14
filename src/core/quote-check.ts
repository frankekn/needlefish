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

// Fixed-string search of one tree. null means git failed (unknown ref, such as
// the uncommitted-mode WORKING sentinel), which leaves the finding unchecked;
// exit 1 is git grep's "no match".
function grepAt(repoPath: string, ref: string, quote: string, file?: string): Hit[] | null {
	// spawnSync throws, rather than fails, on a NUL in argv; file is model output.
	if (quote.includes("\0") || file?.includes("\0")) return null;
	const res = spawnSync(
		"git",
		// The cited file is model output: match it as a literal path, never a
		// glob or pathspec magic such as `*` or `:(top)`.
		["--literal-pathspecs", "grep", "-F", "-n", "-z", "-I", "--no-color", "--no-textconv", "-e", quote, ref, "--", ...(file ? [file] : [])],
		{ cwd: repoPath, encoding: "utf8", maxBuffer: 1024 * 1024 * 16, timeout: 10_000 },
	);
	if (res.error || (res.status !== 0 && res.status !== 1)) return null;
	if (res.status === 1) return [];
	// Each hit is "<ref>:<path>\0<line>\0<text>\n"; the path is verbatim and may
	// hold any byte but NUL, so split on NUL first, never on newline.
	const hits: Hit[] = [];
	const out = res.stdout;
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

function checkOne(finding: Finding, bundle: Bundle, changed: ReadonlySet<string>): Finding {
	const quote = finding.quote;
	if (!quote || quote.replace(/\s/g, "").length < MIN_QUOTE_CHARS) return finding;
	const headHits = grepAt(bundle.repoPath, bundle.headSha, quote);
	if (!headHits) return finding;
	if (headHits.some((hit) => hit.file === finding.file)) {
		return { ...finding, quoteCheck: { status: "matched" } };
	}
	// A finding about removed code quotes a line that only exists at base.
	const baseHits = grepAt(bundle.repoPath, bundle.baseSha, quote, finding.file);
	if (baseHits && baseHits.length > 0) {
		return { ...finding, quoteCheck: { status: "matched" } };
	}
	// -F matches substrings; a move needs the whole line to be the quote, or a
	// comment or string that mentions the quoted code would become the anchor.
	const [hit] = headHits;
	if (headHits.length === 1 && changed.has(hit.file) && hit.text.trim() === quote) {
		// The old replacement targets the old lines; applied at the new
		// location it would be a wrong GitHub suggestion.
		return {
			...finding,
			file: hit.file,
			lineStart: hit.line,
			lineEnd: hit.line,
			replacement: undefined,
			quoteCheck: { status: "moved", from: `${finding.file}:${finding.lineStart}` },
		};
	}
	return { ...finding, quoteCheck: { status: "not_found" } };
}

// Annotates and, on one unique changed-line match, relocates findings. It
// never drops a finding or changes severity, so it cannot move the verdict.
export function checkQuotes(findings: readonly Finding[], bundle: Bundle): Finding[] {
	const changed = new Set(bundle.changedFiles.map((file) => file.path));
	return findings.map((finding) => checkOne(finding, bundle, changed));
}
