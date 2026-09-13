import { readFileSync } from "node:fs";
import { deriveVerdict } from "../core/verdict.js";
import { renderMarkdown } from "../shared/render.js";
import { parseReviewResult } from "../shared/review-result.js";
import type { ReviewResult } from "../shared/schema.js";

function loadCachedResult(file: string): ReviewResult {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`cannot read cached review ${file}: ${detail}`, {
			cause: err,
		});
	}
	try {
		return parseReviewResult(JSON.parse(raw));
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid cached review ${file}: ${detail}`, {
			cause: err,
		});
	}
}

export function runCachedRender(file: string): void {
	process.stdout.write(renderMarkdown(loadCachedResult(file)));
}

// Read-only verdict diagnostic: recompute the verdict from the cached
// findings/residuals with the current deriveVerdict and compare it to the
// stored verdict. Drift (different derivation logic at write time, or an
// edited cache) exits nonzero so scripts can gate on it.
export function runCachedVerdict(file: string): void {
	const result = loadCachedResult(file);
	const derived = deriveVerdict(result.findings, result.residualRisks);
	process.stdout.write(`stored:  ${result.verdict}\nderived: ${derived}\n`);
	if (derived !== result.verdict) {
		process.stderr.write(
			`needlefish: cached verdict ${result.verdict} does not match derived ${derived}\n`,
		);
		process.exitCode = 1;
	}
}
