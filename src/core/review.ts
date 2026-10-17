import {
	runCodex,
	resolveRunnerConfig,
	type EffectiveRunnerConfig,
	extractJson,
	isRunnerSafetyError,
	MALFORMED_OUTPUT_NEXT_STEP,
	type CodexOptions,
} from "../shared/codex.js";
import {
	parsePositiveInteger,
	type RunnerOptions,
	type ConnectionOutputGuard,
	type RunStat,
} from "../shared/runner.js";
import { isDocsFastPathEligible } from "../shared/classify.js";
import { envFlagOn } from "../shared/env.js";
import { findRunnerFailure } from "../shared/runner-failure.js";
import { AcpEnvironmentAuth } from "../shared/connection-auth.js";
import { reviewRuntime } from "../shared/runtime.js";
import {
	assertRunnerSandboxClean,
	prepareRunnerSandbox,
	type RunnerSandbox,
} from "../shared/runner-sandbox.js";
import {
	assertRunnerSchedulingAllowed,
	createManagedTempDirectory,
	disposeManagedTempDirectory,
	registerTerminationFinalizer,
} from "../shared/temp-lifecycle.js";
import { resolveRunner, runnerReviewCapability, RunnerSelectionError } from "../shared/runner-detection.js";
import {
	REVIEW_RESULT_SCHEMA_VERSION,
	type Bundle,
	type CoverageGap,
	type Finding,
	type Hotspot,
	type RawReview,
	type ResidualRisk,
	type ReviewResult,
	type Severity,
} from "../shared/schema.js";
import { normalizeMap, normalizeReview } from "../shared/normalize.js";
import { scopeCallouts } from "./callouts.js";
import { checkQuotes } from "./quote-check.js";
import { collectLargeLiteralContext, hotspotLiteralContext, type LargeLiteralContext } from "./large-literal-context.js";
import { deriveVerdict } from "./verdict.js";
import { loadPrompt } from "./prompts.js";
import {
	observeCandidateReviewTrace,
	observeFinalReviewTrace,
	observeMapCandidateTrace,
	observeReviewTrace,
} from "./review-trace.js";
import type {
	ReviewTraceObserver,
	ReviewTracePassKind,
	ReviewTraceProvenance,
} from "./review-trace.js";

const LARGE_PATCH_CHARS = 30000;
const LARGE_FILE_COUNT = 10;
const MAX_HOTSPOTS = 6;
const DEFAULT_DEEP_CONCURRENCY = 3;
const SEV_RANK: Record<Severity, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

// Stage boundaries of a model-backed review, for human progress display.
// Observation only: nothing here feeds prompts, findings, or the result.
export type ReviewProgressEvent =
	| { readonly stage: "review"; readonly files: number }
	| { readonly stage: "map"; readonly files: number }
	| {
			readonly stage: "deep";
			readonly done: number;
			readonly failed: number;
			readonly total: number;
			readonly tail: boolean;
	  }
	| { readonly stage: "dedup"; readonly before: number; readonly after: number }
	| { readonly stage: "critic"; readonly findings: number }
	| { readonly stage: "done"; readonly durationMs: number };

export type ReviewProgressObserver = (event: ReviewProgressEvent) => void;

interface TraceDeliveryHealth {
	// Mutable: set true on the first observer throw. Review semantics continue;
	// consumers (eval score) withhold robustness when this is true.
	failed: boolean;
	readonly pending: Set<Promise<void>>;
}

interface ReviewRun {
	readonly bundle: Bundle;
	readonly runnerConfig: EffectiveRunnerConfig;
	readonly runtime: NonNullable<ReviewResult["runtime"]>;
	readonly snapshot?: Pick<RunnerSandbox, "repoPath" | "expectedHeadSha" | "expectedBaseSha">;
	readonly outputGuards: readonly ConnectionOutputGuard[];
	readonly stats: RunStat[];
	// Raw text of every failed parse attempt across all passes, kept even when
	// a retry later succeeds — the eval canary scan must see emit-then-clean-up
	// sequences. Mutable accumulator, same pattern as stats.
	readonly failedRawOutputs: string[];
	// Raw text of every SUCCESSFUL attempt (trace-gated collection): some pass
	// outputs are consumed but not retained in the final result (map hotspot
	// why/edges, critic-pruned residual text) — the canary scan needs the full
	// transcript, not just what survived into ReviewResult.
	readonly rawOutputs: string[];
	// Merged LFS reports of every pass's sandbox. A Set because each pass
	// prepares its own sandbox of the same checkout and reports the same list.
	readonly lfs: { readonly pointerFiles: Set<string>; scanIncomplete: boolean };
	readonly onTrace?: ReviewTraceObserver;
	// Present only when the caller registered a trace observer.
	readonly traceHealth?: TraceDeliveryHealth;
	readonly onProgress?: ReviewProgressObserver;
	readonly startedAt: number;
	readonly reviewDeadlineMs?: number;
	readonly literalContext: () => Promise<LargeLiteralContext>;
}

interface ReviewPass {
	readonly passKind: ReviewTracePassKind;
	readonly passIndex: number;
}

interface PromptSpec<T> extends ReviewPass {
	readonly label: string;
	readonly prompt: string;
	readonly parse: (raw: unknown) => T;
	readonly maxAttempts?: 3;
}

interface PromptResult<T> extends ReviewTraceProvenance {
	readonly value: T;
}

interface SuccessfulRaw {
	readonly content: string;
	readonly runnerAttempt: number;
}

interface TraceAttempt extends ReviewPass {
	readonly promptAttempt: number;
	readonly onSuccessfulRaw: (raw: string, runnerAttempt: number) => void;
}

function envPositiveInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw === undefined || raw === "") return fallback;
	return parsePositiveInteger(raw, name);
}

function deepConcurrency(): number {
	return envPositiveInt(
		"NEEDLEFISH_DEEP_CONCURRENCY",
		DEFAULT_DEEP_CONCURRENCY,
	);
}

// Eval-only: when set to "1", ReviewResult carries candidateFindings (the
// pre-critic finding list) so the eval scorer can detect critic prune-errors.
// Zero cost when off — callers still pass the candidate list (a reference),
// but it is only attached to the result here when the flag is on. Strictly
// "1", matching the eval lane (eval/run.ts) and NEEDLEFISH_EPHEMERAL_HOME:
// "0" must mean OFF, not "attach transcripts to results the local adapter
// then serializes to disk".
function evalTraceOn(): boolean {
	return process.env.NEEDLEFISH_EVAL_TRACE === "1";
}

async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	let failed = false;
	// Drain before throwing: on a failure, no NEW items start, but every
	// in-flight worker settles before the first rejection propagates. A
	// fail-fast Promise.all would reject while sibling passes are still
	// emitting — anything they produce after the rejection (including a
	// canary) would be lost to the terminal error's transcript snapshot.
	const settled = await Promise.allSettled(
		Array.from(
			{ length: Math.max(1, Math.min(limit, items.length)) },
			async () => {
				while (!failed && next < items.length) {
					const i = next++;
					try {
						results[i] = await fn(items[i], i);
					} catch (err) {
						failed = true;
						throw err;
					}
				}
			},
		),
	);
	const rejections = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
	const rejection = rejections.find((s) => isRunnerSafetyError(s.reason))
		?? rejections.find((s) => findRunnerFailure(s.reason)?.kind !== "quota_exhausted")
		?? rejections[0];
	if (rejection) throw rejection.reason;
	return results;
}

function isLarge(bundle: Bundle): boolean {
	return (
		bundle.patch.length >
			envPositiveInt("NEEDLEFISH_LARGE_PATCH_CHARS", LARGE_PATCH_CHARS) ||
		bundle.changedFiles.length >
			envPositiveInt("NEEDLEFISH_LARGE_FILE_COUNT", LARGE_FILE_COUNT)
	);
}

function changedHotspots(
	hotspots: readonly Hotspot[],
	bundle: Bundle,
): Hotspot[] {
	const changed = new Set(bundle.changedFiles.map((file) => file.path));
	return hotspots
		.map((hotspot) => ({
			...hotspot,
			files: hotspot.files.filter((file) => changed.has(file)),
		}))
		.filter((hotspot) => hotspot.files.length > 0);
}

function dedup(findings: readonly Finding[]): Finding[] {
	const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
	const out = new Map<string, Finding>();
	for (const f of findings) {
		const key = JSON.stringify([f.file, f.lineStart, f.category, norm(f.title), norm(f.whyItBreaks)]);
		const prev = out.get(key);
		if (!prev) {
			out.set(key, f);
			continue;
		}
		const strongest = SEV_RANK[f.severity] < SEV_RANK[prev.severity] ? f : prev;
		if (![prev, f].some((finding) => finding.externalClaims?.some((claim) => claim.necessary))) {
			out.set(key, strongest);
			continue;
		}
		const independent = [prev, f].find((finding) => !finding.externalClaims?.some((claim) => claim.necessary));
		if (independent) {
			out.set(key, independent);
			continue;
		}
		const claims = [...(prev.externalClaims ?? []), ...(f.externalClaims ?? [])];
		out.set(key, {
			...strongest,
			externalClaims: [...new Map(claims.map((claim) => [JSON.stringify(claim), claim])).values()],
		});
	}
	return [...out.values()];
}

function sortByRisk(hotspots: readonly Hotspot[]): Hotspot[] {
	const rank = { high: 0, med: 1, low: 2 } as const;
	return [...hotspots].sort((a, b) => rank[a.risk] - rank[b.risk]);
}

function codexOptions(
	run: ReviewRun,
	label: string,
	traceAttempt: TraceAttempt,
): CodexOptions {
	return {
		repoPath: run.bundle.repoPath,
		targetHeadSha: run.bundle.headSha,
		...(run.snapshot ? { snapshot: run.snapshot } : {}),
		...(run.bundle.headSha === "WORKING"
			? { targetPatch: run.bundle.patch, targetBaseSha: run.bundle.baseSha }
			: {}),
		label,
		onStat: (stat) => run.stats.push(stat),
		onFailedAttempt: (runnerAttempt, raw) => {
			if (run.onTrace) {
				observeReviewTrace(run.onTrace, {
					content: raw ?? "",
					surface: "raw_failure",
					passKind: traceAttempt.passKind,
					passIndex: traceAttempt.passIndex,
					promptAttempt: traceAttempt.promptAttempt,
					runnerAttempt,
					outcome: "runner_failed",
				});
			}
		},
		// Runner-level failures (crash, nonzero exit) hand their captured stdout
		// here so it joins the same canary-scan accumulator as parse failures.
		// Retention is trace-gated like every other transcript surface: the
		// eval lane always runs with tracing on, and a prod review must not
		// accumulate up to 64 MiB per failed stream for a scan that never runs.
		onFailedRaw: (raw) => {
			if (evalTraceOn() && run.outputGuards.length === 0) run.failedRawOutputs.push(raw);
		},
		// Successful attempts hand over their FULL transcript (resolved output
		// + raw stdout/stderr): a status-0 runner emitting the canary on a
		// stream while writing a clean final message must still reach the scan.
		onRaw: (raw, runnerAttempt) => {
			if (raw && evalTraceOn() && run.outputGuards.length === 0) run.rawOutputs.push(raw);
			traceAttempt.onSuccessfulRaw(raw, runnerAttempt);
		},
		...(run.onTrace ? { onNativeToolTrace: (toolTrace, runnerAttempt) => {
			observeReviewTrace(run.onTrace, {
				content: "", surface: "native_tool_receipts", toolTrace,
				passKind: traceAttempt.passKind, passIndex: traceAttempt.passIndex,
				promptAttempt: traceAttempt.promptAttempt, runnerAttempt,
				outcome: toolTrace.invocation === "accepted" ? "runner_completed" : "runner_failed",
			});
		} } satisfies Pick<CodexOptions, "onNativeToolTrace"> : {}),
		onLfsReport: (report) => {
			for (const file of report.pointerFiles) run.lfs.pointerFiles.add(file);
			if (report.scanIncomplete) run.lfs.scanIncomplete = true;
		},
		effectiveConfig: run.runnerConfig,
		outputGuards: run.outputGuards,
		...(run.reviewDeadlineMs === undefined ? {} : { reviewDeadlineMs: run.reviewDeadlineMs }),
	};
}

// Ride the run-wide transcript along on the error (message unchanged): the
// eval harness scans it for the bait canary — neither invalid output nor a
// cleaner retry is an escape hatch from detection. The snapshot is run-level,
// not call-local, and includes SUCCESSFUL pass outputs too: when a later pass
// rejects there is no ReviewResult, so a canary in an earlier successful map
// or deep transcript would otherwise never reach the scan.
function attachRunRaws(err: unknown, run: Pick<ReviewRun, "failedRawOutputs" | "rawOutputs" | "traceHealth">): void {
	const raws = [...run.failedRawOutputs, ...run.rawOutputs];
	if (!(err instanceof Error)) return;
	if (raws.length > 0) {
		(err as Error & { rawOutputs?: readonly string[] }).rawOutputs = raws;
	}
	// Rejected reviews have no ReviewResult, so delivery health rides the
	// error — otherwise eval scores incomplete streams as healthy robustness.
	if (run.traceHealth?.failed) {
		(err as Error & { traceDeliveryFailed?: boolean }).traceDeliveryFailed =
			true;
	}
}

// By default, retry malformed output once: re-ask the model, never re-parse the
// same text. A pass can opt into a higher bounded attempt count when its output
// is the final validation boundary. Safety errors throw from runCodex itself,
// outside the parse try, so they propagate immediately without a re-ask — but
// still carry the run-wide failed raws (a crashed runner's stdout was pushed
// via onFailedRaw).
async function runJsonPrompt<T>(
	spec: PromptSpec<T>,
	run: ReviewRun,
): Promise<PromptResult<T>> {
	let lastErr: unknown;
	for (
		let promptAttempt = 1;
		promptAttempt <= (spec.maxAttempts ?? 2);
		promptAttempt++
	) {
		let out: string;
		let successfulRunnerAttempt = 1;
		const successfulRaws: SuccessfulRaw[] = [];
		try {
			out = await runCodex(
				spec.prompt,
				codexOptions(run, spec.label, {
					passKind: spec.passKind,
					passIndex: spec.passIndex,
					promptAttempt,
					onSuccessfulRaw: (content, runnerAttempt) => {
						successfulRunnerAttempt = runnerAttempt;
						if (run.onTrace) {
							successfulRaws.push({ content, runnerAttempt });
						}
					},
				}),
			);
		} catch (err) {
			attachRunRaws(err, run);
			throw err;
		}
		let value: T;
		try {
			value = spec.parse(extractJson(out));
		} catch (err) { // no-excuse-ok: catch
			lastErr = err;
			for (const raw of successfulRaws) {
				observeReviewTrace(run.onTrace, {
					content: raw.content,
					surface: "raw_success",
					passKind: spec.passKind,
					passIndex: spec.passIndex,
					promptAttempt,
					runnerAttempt: raw.runnerAttempt,
					outcome: "parse_failed",
				});
			}
			if (out && evalTraceOn() && run.outputGuards.length === 0) run.failedRawOutputs.push(out);
			continue;
		}
		// The successful attempt's full transcript (out + raw streams) was
		// already accumulated via onRaw at the runner layer.
		for (const raw of successfulRaws) {
			observeReviewTrace(run.onTrace, {
				content: raw.content,
				surface: "raw_success",
				passKind: spec.passKind,
				passIndex: spec.passIndex,
				promptAttempt,
				runnerAttempt: raw.runnerAttempt,
				outcome: "parsed",
			});
		}
		return {
			value,
			passKind: spec.passKind,
			passIndex: spec.passIndex,
			promptAttempt,
			runnerAttempt: successfulRunnerAttempt,
		};
	}
	attachRunRaws(lastErr, run);
	throw lastErr;
}

function assertUsableReview(review: RawReview, label: string): void {
	if (!review.summary || review.checked.length === 0) {
		throw new Error(
			`${label} produced no summary or checked list (likely malformed output). ${MALFORMED_OUTPUT_NEXT_STEP}`,
		);
	}
}

function parseUsableReview(label: string): (raw: unknown) => RawReview {
	return (raw) => {
		const review = normalizeReview(raw);
		assertUsableReview(review, label);
		return review;
	};
}

// Critic contract is prune-only (prompts/critic.md). Real critics paraphrase
// title/whyItBreaks/suggestedFix and nudge lineEnd/lineStart; those fields
// are not identity. Matching is file + category + nearest unused candidate
// lineStart within ±2. That window absorbs same-call re-anchoring (statement
// vs condition). It is not the adapter's ±10, which exists for CROSS-ROUND
// drift after code moved. An invented finding shares no candidate
// file+category+near-lineStart and still fails closed. Matched content is
// restored from the candidate so paraphrased text cannot reach deriveVerdict;
// only severity and confidence come from the critic. Unknown keys throw from
// parse so runJsonPrompt retries, then fails closed.
//
// Two unused candidates can sit at the SAME distance from the critic's anchor
// (candidates at 50 and 54, critic anchored at 52). Line distance alone then
// says nothing, and picking by array order restores the neighbour's content
// under this finding's severity — real content, real severity, wrong pairing.
// The tie is broken by token overlap on the text the critic paraphrases
// (title + whyItBreaks): paraphrase keeps the domain words, so overlap ranks
// the intended candidate above an unrelated one. Overlap is a TIE-BREAK ONLY.
// Eligibility is still file + category + ±2 and nothing else, so no text
// comparison can reject a finding that the window admits — the exact-field
// key that rejected 92/252 real reviews on 2026-08-22
// (eval/RESULTS_HISTORY.md) cannot come back through this path. Ordering is
// total and deterministic: nearest line, then higher overlap, then first in
// candidate order.
//
// Assignment is a maximum bipartite matching over that eligibility relation,
// NOT first-come consumption. Greedy consumption destroys globally correct
// assignments: candidates at 50 and 54 with critic findings anchored at 52
// then 50 have a complete assignment (52→54, 50→50), but a greedy pass gives
// 50 to the 52-anchored finding and then rejects a real review — a false
// rejection in the seam whose first version already failed a gate at 92/252
// for rejecting real reviews.
//
// Findings are processed in a canonical CONTENT order rather than array
// order, so the assignment is a function of the two finding sets alone:
// permuting the critic's findings cannot change who matches what. Each
// finding first takes its most-preferred free candidate (nearest line, then
// higher overlap, then candidate order — the tie-break above). Only a finding
// that finds nothing free runs Kuhn's augmenting-path search, which may
// displace an incumbent onto its own second choice. That ordering matters:
// augmenting unconditionally would let a finding with no content signal
// displace one that matched its candidate strongly, undoing the tie-break, so
// displacement happens only when the alternative is rejecting the review
// outright — and the displaced finding still lands on a real candidate it was
// eligible for.
//
// Rejection keeps its exact meaning — the throw fires iff no complete
// matching exists, i.e. some critic finding has no candidate under the same
// eligibility relation. Eligibility is untouched, so this only ever accepts
// MORE real critic output, never less; invention still fails closed, and 1:1
// still holds because a candidate is the match of at most one finding.
//
// Cost, for F critic findings and C candidates: O(F·C) eligibility pairs,
// O(F+C) tokenizations (token sets are built once, not per pair), and Kuhn is
// O(F·E) = O(F²·C) worst case. Both are single digits in practice.
//
// Two things this deliberately does NOT do, both repeatedly proposed and both
// rejected on recorded evidence — do not "fix" them without new evidence:
//
//   1. Require the critic to echo an opaque per-candidate identity token, or
//      make a low-overlap match fail closed. Either turns text back into an
//      admission test. The production critic paraphrases, and the exact-field
//      key that did this rejected 92/252 real reviews (36.5%) on 2026-08-22.
//      A rejection here throws away a whole real review; the defect it would
//      buy is mis-ATTRIBUTION between two real candidates, never invention.
//      Wrong trade.
//   2. Withhold the critic's severity unless identity is "verified" by text
//      similarity. Severity correction in both directions is the critic's job
//      (prompts/critic.md; the severity-correction tests). Gating it on a
//      similarity score would make the VERDICT depend on how heavily the
//      critic paraphrased — a silent, unfalsifiable verdict shift, which is
//      strictly worse in this seam than a loud, testable rule. Severity is a
//      channel the critic legitimately owns for a candidate it matched.
//
// What actually bounds the critic is unchanged: content is always restored
// from a real candidate, and the matching is 1:1, so no critic output can add
// a finding that the candidate review did not contain.
//
// Residuals have no file/line/category — the text is the identity. Word-level
// paraphrase is too collision-prone (an invented blocking residual could
// pair with an unrelated candidate and manufacture needs_human). Identity is
// exact text after case-fold and whitespace collapse. Depleting the bag
// still caps copies.

const CRITIC_FINDING_LINE_WINDOW = 2;

function residualSubsetKey(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function bagByKey<T>(
	items: readonly T[],
	keyOf: (item: T) => string,
): Map<string, T[]> {
	const bag = new Map<string, T[]>();
	for (const item of items) {
		const key = keyOf(item);
		const group = bag.get(key);
		if (group) group.push(item);
		else bag.set(key, [item]);
	}
	return bag;
}

function findingTokens(finding: Finding): Set<string> {
	return new Set(
		`${finding.title} ${finding.whyItBreaks}`
			.toLowerCase()
			.split(/[^\p{L}\p{N}]+/u)
			.filter((token) => token.length > 0),
	);
}

// Jaccard overlap. 0 when either side has no tokens, so an empty-text finding
// falls back to candidate order rather than outranking anything.
function tokenOverlap(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 || b.size === 0) return 0;
	let shared = 0;
	for (const token of a) {
		if (b.has(token)) shared++;
	}
	return shared / (a.size + b.size - shared);
}

// Content-derived, so the processing order below cannot depend on where a
// finding sat in the critic's array. Two findings identical in every field are
// interchangeable: whichever takes which candidate, the restored output is the
// same.
function canonicalFindingKey(finding: Finding): string {
	return [
		finding.file,
		finding.category,
		String(finding.lineStart),
		String(finding.lineEnd),
		finding.severity,
		String(finding.confidence),
		finding.title,
		finding.whyItBreaks,
	].join("\u0000");
}

// The eligibility relation — file + category + ±2 lineStart — and nothing
// else. Order within it is preference only: nearest line, then higher token
// overlap, then candidate order.
function eligibleCandidates(
	finding: Finding,
	candidates: readonly Finding[],
	candidateTokens: readonly Set<string>[],
): number[] {
	const criticTokens = findingTokens(finding);
	const eligible: { index: number; delta: number; overlap: number }[] = [];
	for (let i = 0; i < candidates.length; i++) {
		const candidate = candidates[i];
		if (candidate.file !== finding.file) continue;
		if (candidate.category !== finding.category) continue;
		const delta = Math.abs(candidate.lineStart - finding.lineStart);
		if (delta > CRITIC_FINDING_LINE_WINDOW) continue;
		eligible.push({
			index: i,
			delta,
			overlap: tokenOverlap(criticTokens, candidateTokens[i]),
		});
	}
	eligible.sort(
		(a, b) => a.delta - b.delta || b.overlap - a.overlap || a.index - b.index,
	);
	return eligible.map((entry) => entry.index);
}

// Maximum bipartite matching (Kuhn). Returns one candidate index per critic
// finding, or undefined when no complete matching exists — which is exactly
// the old "this finding was not in the candidate review" condition, since a
// finding with no eligible candidate can never be covered.
function matchCriticFindings(
	criticFindings: readonly Finding[],
	candidates: readonly Finding[],
): number[] | undefined {
	const candidateTokens = candidates.map(findingTokens);
	const adjacency = criticFindings.map((finding) =>
		eligibleCandidates(finding, candidates, candidateTokens),
	);
	const order = criticFindings
		.map((finding, index) => ({ index, key: canonicalFindingKey(finding) }))
		.sort((a, b) =>
			a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index,
		)
		.map((entry) => entry.index);

	const ownerOf = new Array<number>(candidates.length).fill(-1);
	const assign = (finding: number, visited: boolean[]): boolean => {
		for (const candidate of adjacency[finding]) {
			if (visited[candidate]) continue;
			visited[candidate] = true;
			const owner = ownerOf[candidate];
			if (owner < 0 || assign(owner, visited)) {
				ownerOf[candidate] = finding;
				return true;
			}
		}
		return false;
	};

	// Phase 1 takes the most-preferred FREE candidate. Augmenting unconditionally
	// would let a finding with no content signal displace one that matched its
	// candidate strongly — undoing the tie-break — so displacement is deferred.
	const unplaced: number[] = [];
	for (const finding of order) {
		const free = adjacency[finding].find(
			(candidate) => ownerOf[candidate] < 0,
		);
		if (free === undefined) unplaced.push(finding);
		else ownerOf[free] = finding;
	}

	// Phase 2 runs only for findings that found nothing free, where the choice
	// is between displacing an incumbent and rejecting the whole review.
	// Augmenting from a greedy initial matching still yields a maximum matching,
	// and Kuhn's invariant holds: a finding that cannot augment now never can,
	// so a failure here means no complete matching exists at all.
	for (const finding of unplaced) {
		if (!assign(finding, new Array<boolean>(candidates.length).fill(false))) {
			return undefined;
		}
	}

	const matched = new Array<number>(criticFindings.length).fill(-1);
	for (let candidate = 0; candidate < ownerOf.length; candidate++) {
		const owner = ownerOf[candidate];
		if (owner >= 0) matched[owner] = candidate;
	}
	return matched;
}

function takeResidual(
	bag: Map<string, ResidualRisk[]>,
	risk: ResidualRisk,
): ResidualRisk | undefined {
	const group = bag.get(residualSubsetKey(risk.text));
	if (!group || group.length === 0) return undefined;
	if (risk.blocks) {
		const index = group.findIndex((candidate) => candidate.blocks);
		if (index < 0) return undefined;
		const [matched] = group.splice(index, 1);
		return matched;
	}
	const nonBlocking = group.findIndex((candidate) => !candidate.blocks);
	const index = nonBlocking >= 0 ? nonBlocking : 0;
	const [matched] = group.splice(index, 1);
	return matched;
}

function assertCriticSubset(
	critic: RawReview,
	candidate: RawReview,
): RawReview {
	const matched = matchCriticFindings(critic.findings, candidate.findings);
	if (!matched) {
		throw new Error(
			"malformed critic output: finding was not in the candidate review",
		);
	}
	const findings: Finding[] = critic.findings.map((finding, index) => ({
		...candidate.findings[matched[index]],
		severity: finding.severity,
		confidence: finding.confidence,
	}));

	const residualBag = bagByKey(candidate.residual_risks, (risk) =>
		residualSubsetKey(risk.text),
	);
	const residual_risks: ResidualRisk[] = [];
	let restoreCandidateResiduals = false;
	for (const risk of critic.residual_risks) {
		const matched = takeResidual(residualBag, risk);
		if (!matched) {
			restoreCandidateResiduals = true;
			break;
		}
		residual_risks.push({
			text: matched.text,
			blocks: risk.blocks,
		});
	}

	return {
		summary: critic.summary,
		findings,
		checked: critic.checked,
		residual_risks: restoreCandidateResiduals
			? candidate.residual_risks
			: residual_risks,
	};
}

function restoreRequiredResiduals(
	current: readonly ResidualRisk[],
	required: readonly ResidualRisk[],
): ResidualRisk[] {
	const restored = new Map<string, ResidualRisk>();
	for (const risk of [...current, ...required]) {
		const key = residualSubsetKey(risk.text);
		if (!restored.has(key) || risk.blocks) restored.set(key, risk);
	}
	return [...restored.values()];
}

async function runCritic(
	candidate: RawReview,
	patchText: string,
	run: ReviewRun,
	requiredResiduals: readonly ResidualRisk[] = [],
): Promise<PromptResult<RawReview>> {
	const { bundle } = run;
	run.onProgress?.({ stage: "critic", findings: candidate.findings.length });
	const criticPrompt = loadPrompt("critic.md")
		.replace("{{FINDINGS}}", () => JSON.stringify(candidate, null, 2))
		.replace("{{PATCH}}", () => patchText)
		.replace("{{BASE}}", bundle.baseSha)
		.replace("{{HEAD}}", bundle.headSha);
	const result = await runJsonPrompt(
		{
			label: "critic",
			prompt: criticPrompt,
			passKind: "critic",
			passIndex: 0,
			maxAttempts: 3,
			parse: (raw: unknown) =>
				assertCriticSubset(parseUsableReview("critic")(raw), candidate),
		},
		run,
	);
	return {
		...result,
		value: {
			...result.value,
			residual_risks: restoreRequiredResiduals(
				result.value.residual_risks,
				requiredResiduals,
			),
		},
	};
}

function externalPremiseRisks(findings: readonly Finding[]): ResidualRisk[] {
	const risks = findings.flatMap((finding) =>
		(finding.externalClaims ?? []).filter((claim) => claim.necessary).map((claim) => ({
			text: `Unverified external premise for ${finding.file}:${finding.lineStart} (${finding.title}): ${claim.claim} [${claim.source.url}]`,
			blocks: true,
		})),
	);
	return [...new Map(risks.map((risk) => [risk.text, risk])).values()];
}

function toReviewResult(
	raw: RawReview,
	run: ReviewRun,
	summary = raw.summary,
	candidateFindings?: readonly Finding[],
	coverage?: string,
): ReviewResult {
	const { bundle } = run;
	const quoteBundle = run.snapshot ? {
		...bundle,
		repoPath: run.snapshot.repoPath,
		headSha: run.snapshot.expectedHeadSha,
		baseSha: run.snapshot.expectedBaseSha ?? bundle.baseSha,
	} : bundle;
	const unverified = externalPremiseRisks(candidateFindings ?? raw.findings);
	const residualRisks = restoreRequiredResiduals(raw.residual_risks, unverified);
	const findings = raw.findings.filter((finding) => !finding.externalClaims?.some((claim) => claim.necessary));
	const verdict = deriveVerdict(findings, residualRisks);
	// Output-side diagnostics: derived at result assembly, never model input.
	const callouts = scopeCallouts(bundle.changedFiles);
	// Only files in the diff: a pointer elsewhere in the repository is not a
	// gap in this review's coverage. An unfinished scan is, since the diff may
	// touch pointers the sandbox never probed.
	const paths = new Set([...bundle.changedFiles.map((file) => file.path), ...(bundle.binaryFiles ?? [])]);
	const coverageGaps: CoverageGap[] = [...paths]
		.filter((file) => run.lfs.pointerFiles.has(file))
		.map((file) => ({ kind: "lfs_pointer_only", file }));
	const unreviewedBinaryFiles = [...new Set(bundle.binaryFiles)].filter((file) => !run.lfs.pointerFiles.has(file));
	if (run.lfs.scanIncomplete) coverageGaps.push({ kind: "lfs_scan_incomplete" });
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		verdict,
		runtime: run.runtime,
		summary,
		// After the verdict on purpose: the quote check may relocate or
		// annotate a finding, never decide pass/fail.
		findings: checkQuotes(findings, quoteBundle, run.reviewDeadlineMs),
		checked: raw.checked,
		residualRisks,
		baseSha: bundle.baseSha,
		headSha: bundle.headSha,
		...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
		...(callouts.length > 0 ? { scopeCallouts: callouts } : {}),
		...(unreviewedBinaryFiles.length > 0 ? { unreviewedBinaryFiles } : {}),
		...(coverageGaps.length > 0 ? { coverageGaps } : {}),
		...(run.stats.length > 0 ? { stats: [...run.stats] } : {}),
		totalDurationMs: Date.now() - run.startedAt,
		...(coverage ? { coverage: bundle.binaryFiles?.length ? `${coverage}; binary file contents excluded (see Not reviewed)` : coverage } : {}),
		...(evalTraceOn() && candidateFindings ? { candidateFindings } : {}),
		...(evalTraceOn() && run.failedRawOutputs.length > 0
			? { failedRawOutputs: [...run.failedRawOutputs] }
			: {}),
		...(evalTraceOn() && run.rawOutputs.length > 0
			? { rawOutputs: [...run.rawOutputs] }
			: {}),
		...(run.traceHealth
			? { traceDeliveryFailed: run.traceHealth.failed }
			: {}),
	};
}

// Isolate review semantics from telemetry faults: observer throws mark
// delivery health failed but never abort the review or add model retries.
function wrapTraceObserver(
	onTrace: ReviewTraceObserver,
	health: TraceDeliveryHealth,
): ReviewTraceObserver {
	return (event) => {
		try {
			const delivery = Promise.resolve(onTrace(event))
				.catch(() => {
					health.failed = true;
				})
				.finally(() => {
					health.pending.delete(delivery);
				});
			health.pending.add(delivery);
		} catch {
			health.failed = true;
		}
	};
}

async function drainTraceDeliveries(
	health: TraceDeliveryHealth | undefined,
): Promise<void> {
	if (!health) return;
	await Promise.all([...health.pending]);
}

// Small PR: one review call over the full diff. The diff goes in as raw text
// between sentinel lines — never inside the JSON bundle, where escaping
// inflates tokens and hurts the model's read of the hunks.
async function reviewSmall(run: ReviewRun): Promise<ReviewResult> {
	const { bundle } = run;
	const { patch, ...meta } = bundle;
	delete meta.binaryFiles;
	const reviewPrompt = loadPrompt("review.md")
		.replace("{{BUNDLE}}", () => JSON.stringify(meta, null, 2))
		.replace("{{PATCH}}", () => patch);
	run.onProgress?.({ stage: "review", files: bundle.changedFiles.length });
	const candidate = await runJsonPrompt(
		{
			label: "review",
			prompt: reviewPrompt,
			passKind: "review",
			passIndex: 0,
			parse: parseUsableReview("review"),
		},
		run,
	);
	await observeCandidateReviewTrace({
		observer: run.onTrace,
		review: candidate.value,
		provenance: candidate,
	});
	const coverage = `full diff reviewed in one pass (${bundle.changedFiles.length} file${bundle.changedFiles.length === 1 ? "" : "s"})`;
	const critic = await runCritic(candidate.value, bundle.patch, run);
	await observeFinalReviewTrace({
		observer: run.onTrace,
		review: critic.value,
		summary: critic.value.summary,
		provenance: critic,
	});
	return toReviewResult(
		critic.value,
		run,
		undefined,
		candidate.value.findings,
		coverage,
	);
}

// Large PR: map (blast-radius survey, no diff text) -> deep per hotspot -> merge -> critic.
async function reviewLarge(run: ReviewRun): Promise<ReviewResult> {
	const { bundle } = run;
	const mapBundle = {
		baseSha: bundle.baseSha,
		headSha: bundle.headSha,
		patchStat: bundle.patchStat,
		changedFiles: bundle.changedFiles,
		untrackedSkipped: bundle.untrackedSkipped,
		agentsMd: bundle.agentsMd,
		prMeta: bundle.prMeta,
		focus: bundle.focus,
		deep: bundle.deep,
	};
	const mapPrompt = loadPrompt("map.md").replace("{{BUNDLE}}", () =>
		JSON.stringify(mapBundle, null, 2),
	);
	run.onProgress?.({ stage: "map", files: bundle.changedFiles.length });
	const mapResult = await runJsonPrompt(
		{
			label: "map",
			prompt: mapPrompt,
			passKind: "map",
			passIndex: 0,
			parse: normalizeMap,
		},
		run,
	);
	await observeMapCandidateTrace({
		observer: run.onTrace,
		mapResult: mapResult.value,
		provenance: mapResult,
	});
	const mappedHotspots = changedHotspots(mapResult.value.hotspots, bundle);
	const hotspots = sortByRisk(mappedHotspots).slice(0, MAX_HOTSPOTS);

	// Coverage backstop: any changed file not in a selected hotspot goes into a tail
	// hotspot so it still gets deep-reviewed (never silently skip a changed file).
	const covered = new Set(hotspots.flatMap((h) => h.files));
	const uncovered = bundle.changedFiles
		.map((f) => f.path)
		.filter((p) => !covered.has(p));
	let tailAdded = false;
	if (uncovered.length > 0) {
		tailAdded = true;
		hotspots.push({
			name: "tail-coverage (files not mapped to a surface)",
			files: uncovered,
			why: "coverage backstop: these changed files were not assigned to any surface",
			risk: "low",
			edges: [],
		});
	}
	if (hotspots.length === 0) {
		throw new Error("map pass produced no changed-file hotspots");
	}

	const literalContext = await run.literalContext();
	const agents = bundle.agentsMd;
	let deepDone = 0;
	let deepFailed = 0;
	const reportDeep = () =>
		run.onProgress?.({
			stage: "deep",
			done: deepDone,
			failed: deepFailed,
			total: hotspots.length,
			tail: tailAdded,
		});
	const countDeepPass =
		<R extends { readonly ok: boolean }>(
			pass: (h: Hotspot, passIndex: number) => Promise<R>,
		) =>
		async (h: Hotspot, passIndex: number): Promise<R> => {
			const result = await pass(h, passIndex);
			deepDone++;
			if (!result.ok) deepFailed++;
			reportDeep();
			return result;
		};
	reportDeep();
	// mapLimit drains every in-flight deep pass before rethrowing, so the
	// snapshot refresh in the catch below sees transcripts siblings emitted
	// AFTER the first rejection — the per-pass snapshot attached inside
	// runJsonPrompt is stale by then.
	let passes;
	const deepFailures: unknown[] = [];
	try {
		passes = await mapLimit(
			hotspots,
			deepConcurrency(),
			countDeepPass(async (h, passIndex) => {
				const hotspot = {
					...h,
					literalContext: hotspotLiteralContext(literalContext, h),
					...(bundle.untrackedSkipped?.length
						? { untrackedSkipped: bundle.untrackedSkipped }
						: {}),
				};
				const deepPrompt = loadPrompt("deep.md")
					.replace("{{AGENTS}}", () => agents)
					.replace("{{PR_META}}", () =>
						JSON.stringify(bundle.prMeta, null, 2),
					)
					.replace("{{HOTSPOT}}", () => JSON.stringify(hotspot, null, 2))
					.replace("{{FOCUS}}", bundle.focus ?? "(none)")
					.replace("{{BASE}}", bundle.baseSha)
					.replace("{{HEAD}}", bundle.headSha);
				try {
					const res = await runJsonPrompt(
						{
							label: `deep:${h.name}`,
							prompt: deepPrompt,
							passKind: "deep",
							passIndex,
							parse: parseUsableReview(`deep:${h.name}`),
						},
						run,
					);
					await observeCandidateReviewTrace({
						observer: run.onTrace,
						review: res.value,
						provenance: res,
					});
					return {
						ok: true,
						checked: [
							`[${h.name}] ${res.value.summary || "(no summary)"}`,
							...res.value.checked,
						],
						findings: res.value.findings,
						residuals: res.value.residual_risks,
					};
				} catch (e) {
					deepFailures.push(e);
					if (isRunnerSafetyError(e)) throw e;
					const failure = findRunnerFailure(e);
					if (failure?.kind === "quota_exhausted" || failure?.kind === "cancelled" || failure?.kind === "startup_timeout" || failure?.kind === "startup_failed" || failure?.stage === "session/new") throw e;
					const msg = e instanceof Error ? e.message : String(e);
					// Swallowed failure; its raw attempts are already in run.failedRawOutputs
					// (runJsonPrompt accumulates every failed parse there for the eval scan).
					return {
						ok: false,
						checked: [
							`[${h.name}] DEEP PASS FAILED: ${msg.slice(0, 200)}`,
						],
						findings: [] as readonly Finding[],
						residuals: [
							{
								text: `deep review of "${h.name}" failed (${msg.slice(0, 150)}); ${h.files.length} file(s) not deep-reviewed`,
								blocks: true,
							},
						] as readonly ResidualRisk[],
					};
				}
			}),
		);
	} catch (err) {
		const fatal = findRunnerFailure(err)?.kind === "quota_exhausted"
			? deepFailures.find((failure) => findRunnerFailure(failure)?.kind !== "quota_exhausted") ?? err : err;
		attachRunRaws(fatal, run);
		throw fatal;
	}
	const all = passes.flatMap((p) => p.findings);
	const checked = passes.flatMap((p) => p.checked);
	const merged = dedup(all);
	const residuals = [...passes.flatMap((p) => p.residuals), ...externalPremiseRisks(merged)];
	run.onProgress?.({ stage: "dedup", before: all.length, after: merged.length });
	const candidateMerged: RawReview = {
		summary: mapResult.value.summary,
		findings: merged,
		checked,
		residual_risks: residuals,
	};
	const pruned = await runCritic(
		candidateMerged,
		bundle.patchStat || "(see git diff --stat; repo at HEAD)",
		run,
		passes.filter((pass) => !pass.ok).flatMap((pass) => pass.residuals),
	);
	const final = pruned.value;
	// Compute coverage from the hotspots whose deep pass actually SUCCEEDED
	// (includes the tail backstop). A failed pass's files were not reviewed —
	// counting them (or their hotspot) would make the coverage line overstate
	// exactly when it matters most; the failure itself is a blocking residual.
	const okHotspots = hotspots.filter((_, i) => passes[i].ok);
	const coveredFileCount = new Set(okHotspots.flatMap((h) => h.files)).size;
	const tailOk = tailAdded && passes[passes.length - 1].ok;
	const coverage = `${coveredFileCount}/${bundle.changedFiles.length} changed files deep-reviewed across ${okHotspots.length} hotspot${okHotspots.length === 1 ? "" : "s"}${tailOk ? ", incl. tail-coverage" : ""}`;
	const summary = `${mapResult.value.summary} — ${pruned.value.summary}`;
	await observeFinalReviewTrace({
		observer: run.onTrace,
		review: final,
		summary,
		provenance: pruned,
	});
	return toReviewResult(
		final,
		run,
		summary,
		merged,
		coverage,
	);
}

// Docs-only fast path: skip model calls only when every changed file is
// classified "docs" AND is user-facing prose (not model/agent policy
// Markdown). classify.ts rule order already routes workflow yml to
// "workflow", so CI files can never ride this path. Executable files under
// a docs/ directory are not classified "docs" (Markdown extension required).
export function isDocsOnlyFastPath(bundle: Bundle): boolean {
	return (
		bundle.changedFiles.length > 0 &&
		bundle.changedFiles.every(
			(f) => isDocsFastPathEligible(f.surface, f.path),
		) &&
		!envFlagOn("NEEDLEFISH_NO_FAST_PATH")
	);
}

// The two dispatch questions review() asks of a bundle, answered in one place
// so --dry-run can report what a real run would do without duplicating
// thresholds. review() itself consumes this; the private helpers stay the
// only threshold owners.
export function reviewPlan(bundle: Bundle, runnerOptions: RunnerOptions): {
	readonly docsOnlyFastPath: boolean;
	readonly binaryOnlyFastPath: boolean;
	readonly largePath: boolean;
	readonly capability: ReturnType<typeof runnerReviewCapability> | {
		readonly runner: null;
		readonly capability: "unresolved";
		readonly detail: string;
	} | null;
} {
	try { resolveRunner(runnerOptions); }
	catch (error) { if (!(error instanceof RunnerSelectionError)) throw error; }
	if (bundle.untrackedSkipped?.length) {
		const omitted = bundle.untrackedSkipped.slice(0, 10)
			.map((file) => `${JSON.stringify(file.path.slice(0, 240))} (${file.reason})`).join(", ");
		throw new Error(`Untracked file contents omitted: ${omitted}${bundle.untrackedSkipped.length > 10 ? "; additional files omitted" : ""}. Stage these files or reduce their size before reviewing.`);
	}
	const docsOnlyFastPath = isDocsOnlyFastPath(bundle);
	const binaryOnlyFastPath = !bundle.patch.trim() && Boolean(bundle.binaryFiles?.length);
	let capability: ReturnType<typeof reviewPlan>["capability"] = null;
	if (!docsOnlyFastPath && !binaryOnlyFastPath) {
		try {
			capability = runnerReviewCapability(resolveRunner(runnerOptions));
		} catch (error) {
			if (!(error instanceof RunnerSelectionError)) throw error;
			capability = { runner: null, capability: "unresolved", detail: error.message };
		}
	}
	// Keep review()'s original evaluation order: the docs-only short-circuit
	// returns before isLarge is ever reached. isLarge parses the
	// NEEDLEFISH_LARGE_* env values, so an invalid value must not fail a
	// docs-only review that would have fast-pathed — and a dry-run must not
	// report a large path that never runs (docs-only + --deep still takes the
	// fast path).
	return {
		docsOnlyFastPath,
		binaryOnlyFastPath,
		largePath: docsOnlyFastPath || binaryOnlyFastPath ? false : bundle.deep || isLarge(bundle),
		capability,
	};
}

export async function review(
	bundle: Bundle,
	runnerOptions: RunnerOptions = {},
	onTrace?: ReviewTraceObserver,
	onProgress?: ReviewProgressObserver,
): Promise<ReviewResult> {
	const startedAt = Date.now();
	const plan = reviewPlan(bundle, runnerOptions);
	if (plan.binaryOnlyFastPath) {
		const files = [...new Set(bundle.binaryFiles)];
		return {
			schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
			verdict: "pass",
			summary: "No text patch to review; model review skipped.",
			findings: [],
			checked: [],
			residualRisks: [],
			baseSha: bundle.baseSha,
			headSha: bundle.headSha,
			...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
			unreviewedBinaryFiles: files,
			coverage: "No text patch reviewed; binary file contents excluded (see Not reviewed)",
			totalDurationMs: Date.now() - startedAt,
		};
	}

	if (plan.docsOnlyFastPath) {
		const paths = bundle.changedFiles.map((f) => f.path).join(", ");
		// Docs-only input produces no callouts today, but compute it the same
		// way so the rule stays uniform if classification changes.
		const callouts = scopeCallouts(bundle.changedFiles);
		const unreviewedBinaryFiles = [...new Set(bundle.binaryFiles)];
		return {
			schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
			verdict: "pass",
			docsOnlyFastPath: true,
			summary: `Docs-only change (${bundle.changedFiles.length} file(s)); model review skipped.`,
			findings: [],
			checked: [`FAST_PATH docs-only files=[${paths}]`],
			residualRisks: [],
			baseSha: bundle.baseSha,
			headSha: bundle.headSha,
			...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
			...(callouts.length > 0 ? { scopeCallouts: callouts } : {}),
			...(unreviewedBinaryFiles.length > 0 ? { unreviewedBinaryFiles } : {}),
			totalDurationMs: Date.now() - startedAt,
		};
	}
	return reviewRoutes(bundle, [runnerOptions], onTrace, onProgress, startedAt);
}

export async function reviewWithConnections(
	bundle: Bundle,
	routes: readonly [RunnerOptions, ...RunnerOptions[]],
	onTrace?: ReviewTraceObserver,
	onProgress?: ReviewProgressObserver,
): Promise<ReviewResult> {
	const plan = reviewPlan(bundle, routes[0]);
	if (plan.docsOnlyFastPath || plan.binaryOnlyFastPath) return review(bundle, {}, onTrace, onProgress);
	return reviewRoutes(bundle, routes, onTrace, onProgress, Date.now());
}

export function reviewBudgetMs(routeCount: number, explicit?: number): number | null {
	if (explicit !== undefined) return parsePositiveInteger(String(explicit), "reviewBudgetMs");
	const timeout = process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS;
	if (routeCount > 1 && !timeout) throw new Error("Ordered connections require NEEDLEFISH_REVIEW_TIMEOUT_MS for one shared review budget.");
	return timeout ? parsePositiveInteger(timeout, "NEEDLEFISH_REVIEW_TIMEOUT_MS") : null;
}

async function reviewRoutes(
	bundle: Bundle,
	routes: readonly [RunnerOptions, ...RunnerOptions[]],
	onTrace: ReviewTraceObserver | undefined,
	onProgress: ReviewProgressObserver | undefined,
	startedAt: number,
): Promise<ReviewResult> {
	const budget = reviewBudgetMs(routes.length, routes[0].reviewBudgetMs);
	const deadline = budget === null ? undefined : performance.now() + budget;
	const select = (options: RunnerOptions) => {
		const plan = reviewPlan(bundle, options);
		if (plan.capability?.capability === "promptOnly" || plan.capability?.capability === "unresolved") throw new Error(plan.capability.detail);
		return { config: resolveRunnerConfig(options), plan };
	};
	const firstSelection = select(routes[0]);
	const selections = [firstSelection, ...routes.slice(1).map(select)];
	const outputGuards = selections.flatMap(({config}) => config.connectionAuth
		? [selections.length > 1 && config.connectionAuth instanceof AcpEnvironmentAuth ? config.connectionAuth.orderedOutputGuard() : config.connectionAuth] : []);
	const traceHealth: TraceDeliveryHealth | undefined = onTrace || (outputGuards.length > 0 && evalTraceOn())
		? { failed: onTrace === undefined, pending: new Set() } : undefined;
	const failedRawOutputs: string[] = [];
	const rawOutputs: string[] = [];
	const tmp = await createManagedTempDirectory();
	let snapshot: RunnerSandbox | undefined;
	let activeRun: ReviewRun | undefined;
	let literalContext: Promise<LargeLiteralContext> | undefined;
	const cancellation = new AbortController();
	const detachCancellation = registerTerminationFinalizer(async () => { cancellation.abort(); });
	let selectedRunner = firstSelection.config.runner;
	const screenError = (error: unknown) => {
		attachRunRaws(error, {
			failedRawOutputs: [...failedRawOutputs, ...(activeRun?.failedRawOutputs ?? [])],
			rawOutputs: [...rawOutputs, ...(activeRun?.rawOutputs ?? [])],
			...(traceHealth ? {traceHealth} : {}),
		});
		if (error instanceof Error && outputGuards.length) error.message = isRunnerSafetyError(error)
			? "Needlefish withheld review sandbox diagnostic because it may contain a selected connection credential."
			: outputGuards.reduce((message, guard) => guard.screenDiagnostic(message), error.message);
		return error;
	};
	const assertSnapshotClean = (retainMetadata = true) => {
		try { if (snapshot) assertRunnerSandboxClean(selectedRunner, snapshot.repoPath, snapshot.expectedHeadSha, retainMetadata); }
		catch (error) { throw screenError(error); }
	};
	try {
		assertRunnerSchedulingAllowed();
		if (deadline !== undefined && performance.now() >= deadline) throw new Error("Needlefish review deadline exceeded");
		snapshot = prepareRunnerSandbox({ runner: selections.some(({config}) => config.runner === "codex" || config.runner === "grok") ? "codex" : firstSelection.config.runner, repoPath: bundle.repoPath, prompt: "", targetHeadSha: bundle.headSha, targetBaseSha: bundle.baseSha, targetPatch: bundle.patch, ...(deadline === undefined ? {} : { remainingReviewMs: () => Math.floor(deadline - performance.now()) }), tmp });
		const capturedSnapshot = { ...snapshot, expectedBaseSha: snapshot.expectedBaseSha ?? bundle.baseSha };
		for (const [routeIndex, {config, plan}] of selections.entries()) {
			selectedRunner = config.runner;
			assertRunnerSchedulingAllowed();
			if (deadline !== undefined && performance.now() >= deadline) throw new Error("Needlefish review deadline exceeded");
			const run: ReviewRun = {
				literalContext: () => literalContext ??= collectLargeLiteralContext({
					bundle, snapshot: capturedSnapshot,
					abortSignal: cancellation.signal,
					...(deadline === undefined ? {} : { reviewDeadlineMs: deadline }),
				}),
				bundle, snapshot, runnerConfig: config, runtime: reviewRuntime(config, budget), outputGuards,
				stats: [], failedRawOutputs: [], rawOutputs: [], lfs: { pointerFiles: new Set(), scanIncomplete: false }, startedAt,
				...(deadline === undefined ? {} : { reviewDeadlineMs: deadline }),
				...(traceHealth ? { traceHealth } : {}),
				...(onTrace && traceHealth ? { onTrace: wrapTraceObserver((event) => onTrace(selections.length > 1 ? Object.freeze({ ...event, routeIndex }) : event), traceHealth) } : {}),
				...(onProgress ? {onProgress} : {}),
			};
			activeRun = run;
			try {
				const result = await (plan.largePath ? reviewLarge(run) : reviewSmall(run));
				await drainTraceDeliveries(traceHealth);
				const final = { ...result,
					...(failedRawOutputs.length ? {failedRawOutputs: [...failedRawOutputs, ...run.failedRawOutputs]} : {}),
					...(rawOutputs.length ? {rawOutputs: [...rawOutputs, ...run.rawOutputs]} : {}),
					...(traceHealth?.failed ? {traceDeliveryFailed: true} : {}),
				};
				for (const guard of outputGuards) guard.assertOutputSafe(JSON.stringify(final));
				onProgress?.({stage:"done",durationMs:Date.now()-startedAt});
				return final;
			} catch (error) {
				await drainTraceDeliveries(traceHealth);
				failedRawOutputs.push(...run.failedRawOutputs);
				rawOutputs.push(...run.rawOutputs);
				activeRun = undefined;
				attachRunRaws(error, {...run, failedRawOutputs, rawOutputs});
				assertSnapshotClean();
				if (findRunnerFailure(error)?.kind !== "quota_exhausted" || routeIndex === selections.length - 1) throw error;
			}
		}
		throw new Error("No review connection selected.");
	} catch (error) {
		throw screenError(error);
	} finally {
		detachCancellation();
		try { assertSnapshotClean(false); }
		finally {
			await disposeManagedTempDirectory(tmp).catch((error: unknown) => { throw screenError(error); });
		}
	}
}
