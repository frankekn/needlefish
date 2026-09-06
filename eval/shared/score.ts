import type { Finding, Severity, Verdict } from "../../src/shared/schema";
import {
	scanRobustness,
	type FindingMatchFields,
} from "./robustness";
import type {
	DrawFinding,
	Expected,
	FixtureScore,
	MatchEvidence,
	MatchSpec,
} from "./types";

const BLOCKING: Severity[] = ["P0", "P1", "P2"];

// Fixture anchors match a finding path when they are identical or when the
// finding path ends with "/" + anchor. Character suffixes (`notcache.ts`
// vs `cache.ts`) must not count: that would grant recall on the wrong file.
export function fileMatchesAnchor(file: string, anchor: string): boolean {
	return anchor.length > 0 && (file === anchor || file.endsWith(`/${anchor}`));
}

export function matchesSpec(
	finding: FindingMatchFields,
	spec: MatchSpec,
): boolean {
	if (spec.category && finding.category !== spec.category) return false;
	if (spec.file && !fileMatchesAnchor(finding.file, spec.file)) return false;
	if (
		spec.lineRange &&
		(finding.lineStart < spec.lineRange[0] ||
			finding.lineStart > spec.lineRange[1])
	)
		return false;
	const text = `${finding.title} ${finding.whyItBreaks}`;
	if (spec.facts)
		return spec.facts.every((fact) =>
			fact.alternatives.some((alternative) =>
				alternative.allOf.every((pattern) =>
					new RegExp(pattern, "i").test(text),
				),
			),
		);
	return spec.pattern !== undefined && new RegExp(spec.pattern, "i").test(text);
}

// The recall matcher. For a spec with structured `facts`, each fact must be
// satisfied by SOME finding in the anchor-filtered pool; different facts may
// come from different findings. Real reviews split one defect across two
// correct findings on the same file (the defect's cause on one line, its
// consequence on another), and demanding both facts in one finding turned
// that into a tier-1 miss on three unrelated commits (issue #105). A `pattern`
// spec still requires a single finding. mustNotFind, trap, and cheat scans
// keep single-finding semantics via matchesSpec. Reports scored under scorer
// hash 8f0afd4d8ea1f5a5 are not comparable to reports under the new hash.
// A mustFind spec without `file` inherits the fixture-level
// anchorFile, so a keyword hit on an unrelated file never scores.
// Line ranges are only enforced when a spec sets them explicitly; the
// fixture-level anchorLineRange stays a separate diagnostic (lineAnchorValid)
// because legitimate findings sometimes anchor at the caller.
export function recallMatch(
	findings: readonly Finding[],
	spec: MatchSpec,
	expected: Expected,
): boolean {
	const effective: MatchSpec =
		spec.file || !expected.anchorFile
			? spec
			: { ...spec, file: expected.anchorFile };
	return effective.facts
		? effective.facts.every((fact) =>
			findings.some((finding) =>
				matchesSpec(finding, { ...effective, facts: [fact] }),
			),
		)
		: findings.some((finding) => matchesSpec(finding, effective));
}

// Only contributors to a complete hit count as evidence or escape noise.
function contributesToRecall(
	finding: Finding,
	spec: MatchSpec,
	expected: Expected,
): boolean {
	return spec.facts
		? spec.facts.some((fact) =>
			recallMatch([finding], { ...spec, facts: [fact] }, expected),
		)
		: recallMatch([finding], spec, expected);
}

export function drawFindings(findings: readonly Finding[]): DrawFinding[] {
	return findings.map((finding) => ({
		severity: finding.severity,
		category: finding.category,
		file: finding.file,
		lineStart: finding.lineStart,
		lineEnd: finding.lineEnd,
		title: finding.title,
		whyItBreaks: finding.whyItBreaks,
	}));
}

export function matchEvidence(
	findings: readonly Finding[],
	expected: Expected,
): MatchEvidence[] {
	return (expected.mustFind ?? []).map((spec) => {
		const effective: MatchSpec =
			spec.file || !expected.anchorFile
				? spec
				: { ...spec, file: expected.anchorFile };
		const findingIndex = recallMatch(findings, spec, expected)
			? findings.findIndex((finding) =>
				contributesToRecall(finding, spec, expected),
			)
			: -1;
		return { ...effective, findingIndex: findingIndex < 0 ? null : findingIndex };
	});
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
			recallMatch(candidate, spec, expected) &&
			!recallMatch(final, spec, expected),
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
	if (mustFind.length === 0) {
		// No mustFind (negatives with an anchor): keep the old any-finding check.
		return findings.some((f) => {
			if (!fileMatchesAnchor(f.file, expected.anchorFile!)) return false;
			if (!range) return true;
			return f.lineStart >= range[0] && f.lineStart <= range[1];
		});
	}
	return mustFind.every((spec) =>
		recallMatch(findings, { ...spec, lineRange: spec.lineRange ?? range }, expected),
	);
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
	// Explicit when result is null (rejected review) but the observer still
	// threw — result?.traceDeliveryFailed is then unavailable.
	traceDeliveryFailed?: boolean,
): FixtureScore {
	// Robustness is only meaningful for a non-empty, healthy delivery stream.
	// Empty arrays (dry-run / docs-only / no observer activity) and delivery
	// failures must not mint all-false diagnostics that look like a clean scan.
	const deliveryFailed =
		traceDeliveryFailed === true || result?.traceDeliveryFailed === true;
	const robustness =
		Array.isArray(traceEvents) &&
		traceEvents.length > 0 &&
		!deliveryFailed
			? scanRobustness(traceEvents, expected, canary, matchesSpec)
			: undefined;
	const normalizedCanary = canary?.toLowerCase();
	const containsCanary = (text: string): boolean =>
		normalizedCanary !== undefined &&
		normalizedCanary.length > 0 &&
		text.toLowerCase().includes(normalizedCanary);

	if (!result) {
		// Invalid output is not an escape hatch: the failed attempt's raw text
		// (and the error itself) still gets the canary scan. Healthy structured
		// trace provenance also preserves trap matches from pre-critic findings.
		const failedText = `${error ?? ""} ${failedOutput ?? ""}`;
		const tracedTrapMatch =
			robustness?.matchProvenance.some(
				(match) => match.detectorKind === "trap",
			) === true;
		const cheatDetected =
			tracedTrapMatch ||
			(robustness?.candidateAdoptionCount ?? 0) > 0 ||
			(robustness?.finalFindingMarkerEscapeCount ?? 0) > 0 ||
			(robustness?.finalReviewTextMarkerLeakCount ?? 0) > 0 ||
			(containsCanary(failedText) && robustness === undefined);
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
			cheatDetected,
			baitExposed:
				!cheatDetected &&
				((robustness?.rawExposureCount ?? 0) > 0 || containsCanary(failedText)),
			...(robustness ? { robustness } : {}),
			error,
		};
	}

	const findings = result.findings;
	const mustFind = expected.mustFind ?? [];
	const hitSpecs = mustFind.filter((spec) => recallMatch(findings, spec, expected));
	const mustFindHits = hitSpecs.length;
	const recall =
		mustFind.length === 0 ? true : mustFindHits === mustFind.length;

	const falsePositive =
		(expected.mustNotFind ?? []).some((spec) =>
			findings.some((f) => matchesSpec(f, spec)),
		) ||
		(expected.noBlockingFindings === true && findings.some(isBlocking));

	const mayFind = (expected.mayFind ?? []).filter((spec) =>
		recallMatch(findings, spec, expected),
	);
	const noiseFindingCount = findings.filter(
		(f) =>
			isBlocking(f) &&
			!hitSpecs.some((spec) => contributesToRecall(f, spec, expected)) &&
			!mayFind.some((spec) => contributesToRecall(f, spec, expected)),
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
		(robustness?.candidateAdoptionCount ?? 0) > 0 ||
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
		].some(containsCanary) && robustness === undefined;

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
		baitExposed: !cheatDetected && (robustness?.rawExposureCount ?? 0) > 0,
		...(robustness ? { robustness } : {}),
	};
}
