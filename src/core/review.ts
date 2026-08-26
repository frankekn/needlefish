import {
	runCodex,
	extractJson,
	isRunnerSafetyError,
	type CodexOptions,
} from "../shared/codex.js";
import {
	parsePositiveInteger,
	type RunnerOptions,
	type RunStat,
} from "../shared/runner.js";
import { isDocsFastPathEligible } from "../shared/classify.js";
import { envFlagOn } from "../shared/env.js";
import {
	REVIEW_RESULT_SCHEMA_VERSION,
	type Bundle,
	type Finding,
	type Hotspot,
	type RawReview,
	type ResidualRisk,
	type ReviewResult,
	type Severity,
} from "../shared/schema.js";
import { normalizeMap, normalizeReview } from "../shared/normalize.js";
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

interface TraceDeliveryHealth {
	// Mutable: set true on the first observer throw. Review semantics continue;
	// consumers (eval score) withhold robustness when this is true.
	failed: boolean;
	readonly pending: Set<Promise<void>>;
}

interface ReviewRun {
	readonly bundle: Bundle;
	readonly runnerOptions: RunnerOptions;
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
	readonly onTrace?: ReviewTraceObserver;
	// Present only when the caller registered a trace observer.
	readonly traceHealth?: TraceDeliveryHealth;
	readonly startedAt: number;
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

// Worker pool over a shared index; results land at their item's index so
// output order never depends on completion order.
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
	const rejection = settled.find(
		(s): s is PromiseRejectedResult => s.status === "rejected",
	);
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
		const key = `${f.file}|${f.lineStart}|${f.category}|${norm(f.title).slice(0, 60)}|${norm(f.whyItBreaks).slice(0, 80)}`;
		const prev = out.get(key);
		if (!prev || SEV_RANK[f.severity] < SEV_RANK[prev.severity])
			out.set(key, f);
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
		...(run.bundle.headSha === "WORKING"
			? { targetPatch: run.bundle.patch }
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
			if (evalTraceOn()) run.failedRawOutputs.push(raw);
		},
		// Successful attempts hand over their FULL transcript (resolved output
		// + raw stdout/stderr): a status-0 runner emitting the canary on a
		// stream while writing a clean final message must still reach the scan.
		onRaw: (raw, runnerAttempt) => {
			if (raw && evalTraceOn()) run.rawOutputs.push(raw);
			traceAttempt.onSuccessfulRaw(raw, runnerAttempt);
		},
		...run.runnerOptions,
	};
}

// Ride the run-wide transcript along on the error (message unchanged): the
// eval harness scans it for the bait canary — neither invalid output nor a
// cleaner retry is an escape hatch from detection. The snapshot is run-level,
// not call-local, and includes SUCCESSFUL pass outputs too: when a later pass
// rejects there is no ReviewResult, so a canary in an earlier successful map
// or deep transcript would otherwise never reach the scan.
function attachRunRaws(err: unknown, run: ReviewRun): void {
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
			if (out && evalTraceOn()) run.failedRawOutputs.push(out);
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
			`${label} produced no summary or checked list (likely malformed output)`,
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
	].join(" ");
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
	const restored = [...current];
	const available = bagByKey(restored, (risk) => residualSubsetKey(risk.text));
	for (const risk of required) {
		if (!takeResidual(available, risk)) restored.push(risk);
	}
	return restored;
}

async function runCritic(
	candidate: RawReview,
	patchText: string,
	run: ReviewRun,
): Promise<PromptResult<RawReview>> {
	const { bundle } = run;
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
	return result;
}

function toReviewResult(
	raw: RawReview,
	run: ReviewRun,
	summary = raw.summary,
	candidateFindings?: readonly Finding[],
	coverage?: string,
): ReviewResult {
	const { bundle } = run;
	const verdict = deriveVerdict(raw.findings, raw.residual_risks);
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		verdict,
		summary,
		findings: raw.findings,
		checked: raw.checked,
		residualRisks: raw.residual_risks,
		baseSha: bundle.baseSha,
		headSha: bundle.headSha,
		...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
		...(run.stats.length > 0 ? { stats: [...run.stats] } : {}),
		totalDurationMs: Date.now() - run.startedAt,
		...(coverage ? { coverage } : {}),
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
	const reviewPrompt = loadPrompt("review.md")
		.replace("{{BUNDLE}}", () => JSON.stringify(meta, null, 2))
		.replace("{{PATCH}}", () => patch);
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

	const agents = bundle.agentsMd;
	// mapLimit drains every in-flight deep pass before rethrowing, so the
	// snapshot refresh in the catch below sees transcripts siblings emitted
	// AFTER the first rejection — the per-pass snapshot attached inside
	// runJsonPrompt is stale by then.
	let passes;
	try {
		passes = await mapLimit(
			hotspots,
			deepConcurrency(),
			async (h, passIndex) => {
				const hotspot = {
					...h,
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
					if (isRunnerSafetyError(e)) throw e;
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
			},
		);
	} catch (err) {
		attachRunRaws(err, run);
		throw err;
	}
	const all = passes.flatMap((p) => p.findings);
	const checked = passes.flatMap((p) => p.checked);
	const residuals = passes.flatMap((p) => p.residuals);

	const merged = dedup(all);
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
	);
	const blockingResiduals = residuals.filter((risk) => risk.blocks);
	const final = {
		...pruned.value,
		residual_risks: restoreRequiredResiduals(
			pruned.value.residual_risks,
			blockingResiduals,
		),
	};
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
function isDocsOnlyFastPath(bundle: Bundle): boolean {
	return (
		bundle.changedFiles.length > 0 &&
		bundle.changedFiles.every(
			(f) => f.surface === "docs" && isDocsFastPathEligible(f.path),
		) &&
		!envFlagOn("NEEDLEFISH_NO_FAST_PATH")
	);
}

export async function review(
	bundle: Bundle,
	runnerOptions: RunnerOptions = {},
	onTrace?: ReviewTraceObserver,
): Promise<ReviewResult> {
	const startedAt = Date.now();

	if (isDocsOnlyFastPath(bundle)) {
		const paths = bundle.changedFiles.map((f) => f.path).join(", ");
		return {
			schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
			verdict: "pass",
			summary: `Docs-only change (${bundle.changedFiles.length} file(s)); model review skipped.`,
			findings: [],
			checked: [`FAST_PATH docs-only files=[${paths}]`],
			residualRisks: [],
			baseSha: bundle.baseSha,
			headSha: bundle.headSha,
			...(bundle.reviewTarget ? { reviewTarget: bundle.reviewTarget } : {}),
			totalDurationMs: Date.now() - startedAt,
		};
	}

	const traceHealth: TraceDeliveryHealth | undefined = onTrace
		? { failed: false, pending: new Set() }
		: undefined;
	const run: ReviewRun = {
		bundle,
		runnerOptions,
		stats: [],
		failedRawOutputs: [],
		rawOutputs: [],
		...(onTrace && traceHealth
			? {
					onTrace: wrapTraceObserver(onTrace, traceHealth),
					traceHealth,
				}
			: {}),
		startedAt,
	};
	try {
		const result = await (bundle.deep || isLarge(bundle)
			? reviewLarge(run)
			: reviewSmall(run));
		await drainTraceDeliveries(traceHealth);
		return traceHealth?.failed
			? { ...result, traceDeliveryFailed: true }
			: result;
	} catch (err) {
		await drainTraceDeliveries(traceHealth);
		attachRunRaws(err, run);
		throw err;
	}
}
