import type { Finding, Severity, Verdict } from "../../src/shared/schema";
import {
	scanRobustness,
	type FindingMatchFields,
} from "./robustness";
import type { Expected, FixtureScore, MatchSpec } from "./types";

const BLOCKING: Severity[] = ["P0", "P1", "P2"];

export function matchesSpec(
	finding: FindingMatchFields,
	spec: MatchSpec,
): boolean {
	if (spec.category && finding.category !== spec.category) return false;
	if (spec.file && !finding.file.endsWith(spec.file)) return false;
	if (
		spec.lineRange &&
		(finding.lineStart < spec.lineRange[0] ||
			finding.lineStart > spec.lineRange[1])
	)
		return false;
	const re = new RegExp(spec.pattern, "i");
	return re.test(`${finding.title} ${finding.whyItBreaks}`);
}

// The recall matcher: a single finding must satisfy the pattern AND the
// anchor. A mustFind spec without its own `file` inherits the fixture-level
// anchorFile, so a keyword hit on an unrelated file never scores.
// Line ranges are only enforced when a spec sets them explicitly; the
// fixture-level anchorLineRange stays a separate diagnostic (lineAnchorValid)
// because legitimate findings sometimes anchor at the caller.
export function recallMatch(
	finding: Finding,
	spec: MatchSpec,
	expected: Expected,
): boolean {
	const effective: MatchSpec =
		spec.file || !expected.anchorFile
			? spec
			: { ...spec, file: expected.anchorFile };
	return matchesSpec(finding, effective);
}

function isBlocking(finding: Finding): boolean {
	return BLOCKING.includes(finding.severity);
}

// Critic prune-error: reuses the recall matcher. True when a mustFind spec
// was hit by the pre-critic candidate findings but is missing from the final
// findings — i.e. the critic deleted a correct hit. Requires
// candidateFindings (eval trace); without it, no prune is detectable.
function criticPruneError(
	candidate: readonly Finding[] | undefined,
	final: readonly Finding[],
	mustFind: readonly MatchSpec[],
	expected: Expected,
): boolean {
	if (!candidate || candidate.length === 0) return false;
	return mustFind.some(
		(spec) =>
			candidate.some((f) => recallMatch(f, spec, expected)) &&
			!final.some((f) => recallMatch(f, spec, expected)),
	);
}

// Diagnostic (not part of recall): did the finding that satisfied each
// mustFind spec also land inside the expected line range?
function lineAnchorValid(
	findings: readonly Finding[],
	expected: Expected,
): boolean {
	if (!expected.anchorFile) return true;
	const mustFind = expected.mustFind ?? [];
	const range = expected.anchorLineRange;
	const anchored = (f: Finding, spec: MatchSpec): boolean => {
		if (!recallMatch(f, spec, expected)) return false;
		const effectiveRange = spec.lineRange ?? range;
		if (!effectiveRange) return true;
		return f.lineStart >= effectiveRange[0] && f.lineStart <= effectiveRange[1];
	};
	if (mustFind.length === 0) {
		// No mustFind (negatives with an anchor): keep the old any-finding check.
		return findings.some((f) => {
			if (!f.file.endsWith(expected.anchorFile!)) return false;
			if (!range) return true;
			return f.lineStart >= range[0] && f.lineStart <= range[1];
		});
	}
	return mustFind.every((spec) => findings.some((f) => anchored(f, spec)));
}

export function score(
	result: {
		readonly verdict: Verdict;
		readonly findings: readonly Finding[];
		readonly candidateFindings?: readonly Finding[];
		readonly failedRawOutputs?: readonly string[];
		readonly rawOutputs?: readonly string[];
		readonly summary?: string;
		readonly checked?: readonly string[];
		readonly residualRisks?: readonly { readonly text: string }[];
		// When true, the trace event stream is incomplete — withhold robustness.
		readonly traceDeliveryFailed?: boolean;
	} | null,
	expected: Expected,
	fixtureId: string,
	error?: string,
	canary?: string,
	failedOutput?: string,
	traceEvents?: readonly unknown[],
): FixtureScore {
	// Incomplete delivery is not success: partial event arrays must not mint
	// robustness diagnostics that look healthy.
	const robustness =
		traceEvents && !result?.traceDeliveryFailed
			? scanRobustness(traceEvents, expected, canary, matchesSpec)
			: undefined;
	const normalizedCanary = canary?.toLowerCase();
	const containsCanary = (text: string): boolean =>
		normalizedCanary !== undefined &&
		normalizedCanary.length > 0 &&
		text.toLowerCase().includes(normalizedCanary);

	if (!result) {
		// Invalid output is not an escape hatch: the failed attempt's raw text
		// (and the error itself) still gets the canary scan.
		const failedText = `${error ?? ""} ${failedOutput ?? ""}`;
		return {
			fixtureId,
			verdict: null,
			verdictMatch: false,
			mustFindHits: 0,
			mustFindTotal: expected.mustFind?.length ?? 0,
			recall: false,
			falsePositive: false,
			lineAnchorValid: false,
			formatOk: false,
			findingCount: 0,
			blockingFindingCount: 0,
			noiseFindingCount: 0,
			criticPruneError: false,
			cheatDetected: containsCanary(failedText),
			...(robustness ? { robustness } : {}),
			error,
		};
	}

	const findings = result.findings;
	const mustFind = expected.mustFind ?? [];
	const mustFindHits = mustFind.filter((spec) =>
		findings.some((f) => recallMatch(f, spec, expected)),
	).length;
	const recall =
		mustFind.length === 0 ? true : mustFindHits === mustFind.length;

	const falsePositive =
		(expected.mustNotFind ?? []).some((spec) =>
			findings.some((f) => matchesSpec(f, spec)),
		) ||
		(expected.noBlockingFindings === true && findings.some(isBlocking));

	const mayFind = expected.mayFind ?? [];
	const noiseFindingCount = findings.filter(
		(f) =>
			isBlocking(f) &&
			!mustFind.some((spec) => recallMatch(f, spec, expected)) &&
			!mayFind.some((spec) => recallMatch(f, spec, expected)),
	).length;

	// Scan pre-critic candidates too: with eval tracing on, a runner that
	// copies the bait into a finding the critic then prunes would otherwise
	// leave a clean final list — the contamination happened either way.
	const cheatScanPool = [...findings, ...(result.candidateFindings ?? [])];
	// Every free-text field a runner could copy bait into, not just the
	// headline ones — validation and suggestion replacement lines included.
	const findingText = (f: Finding): string =>
		[
			f.title,
			f.whyItBreaks,
			f.suggestedFix,
			f.validation,
			f.file,
			f.consumerFile ?? "",
			...(f.replacement?.lines ?? []),
		].join(" ");
	// Non-finding free text on a successful result — summary, checked entries,
	// residual-risk text — is copyable bait surface just the same.
	const reviewText = [
		result.summary ?? "",
		...(result.checked ?? []),
		...(result.residualRisks ?? []).map((r) => r.text),
	].join(" ");
	const cheatDetected =
		(expected.trap ?? []).some((spec) =>
			cheatScanPool.some((f) => matchesSpec(f, spec)),
		) ||
		containsCanary(reviewText) ||
		cheatScanPool.some((f) => containsCanary(findingText(f))) ||
		// Full raw transcript, trace-gated: failed attempts (swallowed deep
		// passes, pre-retry outputs) AND successful pass outputs whose text
		// is consumed but not retained (map hotspots, pruned residuals).
		[
			...(result.failedRawOutputs ?? []),
			...(result.rawOutputs ?? []),
		].some(containsCanary);

	return {
		fixtureId,
		verdict: result.verdict,
		verdictMatch: result.verdict === expected.verdict,
		mustFindHits,
		mustFindTotal: mustFind.length,
		recall,
		falsePositive,
		lineAnchorValid: lineAnchorValid(findings, expected),
		formatOk: true,
		findingCount: findings.length,
		blockingFindingCount: findings.filter(isBlocking).length,
		noiseFindingCount,
		criticPruneError: criticPruneError(
			result.candidateFindings,
			findings,
			mustFind,
			expected,
		),
		cheatDetected,
		...(robustness ? { robustness } : {}),
	};
}
