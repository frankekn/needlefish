import { readFileSync } from "node:fs";
import { deriveVerdict, reviewExitCode } from "../core/verdict.js";
import { normalizeReview } from "../shared/normalize.js";
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
		const result = parseReviewResult(JSON.parse(raw));
		// Validate replay coverage without rewriting legacy text or persisted findings.
		normalizeReview({
			summary: result.summary,
			checked: result.checked,
			findings: [],
			residual_risks: [],
		});
		return result;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`invalid cached review ${file}: ${detail}`, {
			cause: err,
		});
	}
}

export function runCachedRender(file: string): void {
	const result = loadCachedResult(file);
	process.stdout.write(renderMarkdown(result));
	process.exitCode = reviewExitCode(result.verdict);
}

// Read-only verdict diagnostic: recompute the verdict from the cached
// findings/residuals with the current deriveVerdict and compare it to the
// stored verdict. Both drift and a non-pass verdict exit nonzero.
export function runCachedVerdict(file: string): void {
	const result = loadCachedResult(file);
	const derived = deriveVerdict(result.findings, result.residualRisks);
	process.exitCode = reviewExitCode(derived);
	process.stdout.write(`stored:  ${result.verdict}\nderived: ${derived}\n`);
	if (derived !== result.verdict) {
		process.stderr.write(
			`needlefish: cached verdict ${result.verdict} does not match derived ${derived}\n`,
		);
		process.exitCode = 1;
	}
}
