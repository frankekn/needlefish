import { isCompleteReport } from "./report-completeness";
import {
	hasConsistentCheatDetection,
	hasCurrentScorer,
} from "./report-integrity";
import { scorerHash } from "./scorer-hash";
import { ANTICHEAT_VERSION, type DrawResult, type Report } from "./types";

// Empirical fixture difficulty, measured from a zoo of lanes that ran the same
// fixture set under the same prompt contract. Offline only: nothing here feeds
// run.ts, score.ts, or any gate. Binary per-fixture recall compresses every
// lane into a narrow band because most fixtures are solved by everyone; the
// difficulty weight lets the fixtures that still separate lanes carry the
// ranking, and partial credit keeps multi-defect fixtures from scoring 0/1.

export const CALIBRATION_VERSION = 1;
export const MIN_CALIBRATION_LANES = 5;
// Mean partial hit rate at or above this across the zoo = regression layer:
// the fixture still guards against breakage but no longer ranks lanes.
export const SATURATION_THRESHOLD = 0.95;

export type FixtureLayer = "regression" | "discriminating";

export interface FixtureCalibration {
	readonly tier: number | null;
	// Per-lane mean partial hit rate (mustFindHits / mustFindTotal per draw).
	readonly rates: Readonly<Record<string, number>>;
	readonly difficulty: number;
	// Item-rest correlation across lanes. Low or negative on a discriminating
	// fixture means strong lanes miss it as often as weak ones: suspect the
	// answer key or the tier before trusting the weight.
	readonly discrimination: number | null;
	readonly layer: FixtureLayer;
}

export interface Calibration {
	readonly version: typeof CALIBRATION_VERSION;
	readonly fixtureSetHash: string;
	readonly promptHash: string;
	readonly scorerHash: string;
	readonly lanes: readonly string[];
	readonly fixtures: Readonly<Record<string, FixtureCalibration>>;
}

export interface LaneScore {
	readonly lane: string;
	readonly promptHash: string;
	readonly leaveOneOut: boolean;
	readonly binaryRecall: number;
	readonly partialRecall: number;
	readonly weightedRecall: number;
	readonly discriminatingRecall: number;
	readonly discriminatingFixtures: number;
	readonly tier1Recall: number | null;
	// Pre-critic candidate hit rate over draws that carry the eval trace.
	readonly reviewerRecall: number | null;
	// Share of reviewer hits the critic kept.
	readonly criticRetention: number | null;
	readonly noisePerPositive: number;
	readonly falsePositiveRate: number;
	readonly operationalFailureRate: number;
	readonly meanSecondsPerDraw: number;
}

export function laneKey(report: Report): string {
	return `${report.runner}/${report.model ?? "default"}@${report.effort ?? "default"} ${report.createdAt}`;
}

// Same admission rule as the published results: current anti-cheat
// generation, current scorer, no fired canary, consistent detections, and
// exact fixture-by-draw coverage. A compromised report's numbers are void.
export function reportAdmissionError(report: Report): string | null {
	if (report.anticheatVersion !== ANTICHEAT_VERSION)
		return `anticheatVersion ${String(report.anticheatVersion)} != ${ANTICHEAT_VERSION}`;
	if (!hasCurrentScorer(report)) return "scorerHash differs from current scorer";
	if ((report.aggregates?.cheatDetectedCount ?? 1) !== 0)
		return "cheat detected: report is void";
	if (!hasConsistentCheatDetection(report))
		return "aggregates do not account for per-draw detections";
	if (!isCompleteReport(report)) return "incomplete fixture-by-draw coverage";
	if (!report.fixtureSetHash || !report.promptHash)
		return "missing fixtureSetHash or promptHash";
	return null;
}

function isPositive(result: DrawResult): boolean {
	return result.score.mustFindTotal > 0;
}

function mean(values: readonly number[]): number {
	return values.length
		? values.reduce((sum, value) => sum + value, 0) / values.length
		: 0;
}

export function fixtureRates(report: Report): Map<string, number> {
	const byFixture = new Map<string, number[]>();
	for (const result of report.results) {
		if (!isPositive(result)) continue;
		const rates = byFixture.get(result.fixtureId) ?? [];
		rates.push(result.score.mustFindHits / result.score.mustFindTotal);
		byFixture.set(result.fixtureId, rates);
	}
	return new Map([...byFixture].map(([id, rates]) => [id, mean(rates)]));
}

function correlation(xs: readonly number[], ys: readonly number[]): number | null {
	const mx = mean(xs);
	const my = mean(ys);
	let sxy = 0;
	let sxx = 0;
	let syy = 0;
	for (let i = 0; i < xs.length; i++) {
		sxy += (xs[i] - mx) * (ys[i] - my);
		sxx += (xs[i] - mx) ** 2;
		syy += (ys[i] - my) ** 2;
	}
	return sxx === 0 || syy === 0 ? null : sxy / Math.sqrt(sxx * syy);
}

export function buildCalibration(reports: readonly Report[]): Calibration {
	for (const report of reports) {
		const error = reportAdmissionError(report);
		if (error) throw new Error(`${laneKey(report)}: ${error}`);
	}
	if (reports.length < MIN_CALIBRATION_LANES)
		throw new Error(
			`calibration needs at least ${MIN_CALIBRATION_LANES} admitted lanes, got ${reports.length}`,
		);
	const [first] = reports;
	for (const report of reports) {
		if (report.fixtureSetHash !== first.fixtureSetHash)
			throw new Error(`${laneKey(report)}: fixtureSetHash differs`);
		if (report.promptHash !== first.promptHash)
			throw new Error(`${laneKey(report)}: promptHash differs`);
	}
	const lanes = reports.map(laneKey);
	if (new Set(lanes).size !== lanes.length)
		throw new Error("duplicate lane keys");

	const perLane = reports.map(fixtureRates);
	const fixtureIds = [...perLane[0].keys()].sort();
	for (const [index, rates] of perLane.entries()) {
		if (rates.size !== fixtureIds.length || fixtureIds.some((id) => !rates.has(id)))
			throw new Error(`${lanes[index]}: positive fixture set differs`);
	}

	const fixtures: Record<string, FixtureCalibration> = {};
	for (const id of fixtureIds) {
		const values = perLane.map((rates) => rates.get(id) ?? 0);
		const rest = perLane.map((rates) =>
			mean(fixtureIds.filter((other) => other !== id).map((other) => rates.get(other) ?? 0)),
		);
		const meanRate = mean(values);
		fixtures[id] = {
			tier: first.fixtureTiers?.[id] ?? null,
			rates: Object.fromEntries(lanes.map((lane, i) => [lane, values[i]])),
			difficulty: 1 - meanRate,
			discrimination: correlation(values, rest),
			layer: meanRate >= SATURATION_THRESHOLD ? "regression" : "discriminating",
		};
	}
	return {
		version: CALIBRATION_VERSION,
		fixtureSetHash: first.fixtureSetHash as string,
		promptHash: first.promptHash,
		scorerHash: scorerHash(),
		lanes,
		fixtures,
	};
}

// Difficulty as seen by every calibration lane except the one being scored,
// so a lane never grades itself.
function looMeanRate(fixture: FixtureCalibration, exclude: string): number {
	const values = Object.entries(fixture.rates)
		.filter(([lane]) => lane !== exclude)
		.map(([, rate]) => rate);
	return mean(values);
}

export function scoreLane(calibration: Calibration, report: Report): LaneScore {
	const error = reportAdmissionError(report);
	if (error) throw new Error(`${laneKey(report)}: ${error}`);
	if (report.fixtureSetHash !== calibration.fixtureSetHash)
		throw new Error(
			`${laneKey(report)}: fixtureSetHash ${report.fixtureSetHash} does not match calibration ${calibration.fixtureSetHash}`,
		);
	if (calibration.scorerHash !== scorerHash())
		throw new Error("calibration was built under a different scorer");

	const lane = laneKey(report);
	const leaveOneOut = calibration.lanes.includes(lane);
	const rates = fixtureRates(report);
	const ids = Object.keys(calibration.fixtures);
	if (ids.some((id) => !rates.has(id)))
		throw new Error(`${lane}: report lacks calibrated positive fixtures`);

	let weightSum = 0;
	let weighted = 0;
	const discriminating: number[] = [];
	for (const id of ids) {
		const meanRate = looMeanRate(calibration.fixtures[id], lane);
		const rate = rates.get(id) ?? 0;
		weightSum += 1 - meanRate;
		weighted += (1 - meanRate) * rate;
		if (meanRate < SATURATION_THRESHOLD) discriminating.push(rate);
	}

	const positives = report.results.filter(isPositive);
	const tier1 = positives.filter(
		(result) => calibration.fixtures[result.fixtureId]?.tier === 1,
	);
	let candidateHits = 0;
	let candidateSpecs = 0;
	let retained = 0;
	for (const result of positives) {
		const candidate = result.candidateMatchEvidence;
		const final = result.matchEvidence;
		if (!candidate || !final) continue;
		candidateSpecs += candidate.length;
		candidate.forEach((evidence, index) => {
			if (evidence.findingIndex === null) return;
			candidateHits += 1;
			const kept = final[index];
			if (kept && kept.findingIndex !== null) retained += 1;
		});
	}

	return {
		lane,
		promptHash: report.promptHash,
		leaveOneOut,
		binaryRecall: mean(positives.map((result) => (result.score.recall ? 1 : 0))),
		partialRecall: mean(ids.map((id) => rates.get(id) ?? 0)),
		weightedRecall: weightSum > 0 ? weighted / weightSum : 0,
		discriminatingRecall: mean(discriminating),
		discriminatingFixtures: discriminating.length,
		tier1Recall: tier1.length
			? mean(tier1.map((result) => (result.score.recall ? 1 : 0)))
			: null,
		reviewerRecall: candidateSpecs ? candidateHits / candidateSpecs : null,
		criticRetention: candidateHits ? retained / candidateHits : null,
		noisePerPositive: report.aggregates.meanNoisePerPositive,
		falsePositiveRate: report.aggregates.falsePositiveRate,
		operationalFailureRate: mean(
			report.results.map((result) => (result.score.formatOk ? 0 : 1)),
		),
		meanSecondsPerDraw: report.aggregates.meanDurationMs / 1000,
	};
}

// The acceptance core: positives the whole zoo solves, plus every Tier-1. A
// lane that can review at all catches these on every draw; edge cases in the
// discriminating layer are recorded, not required.
export function coreFixtureIds(calibration: Calibration): string[] {
	return Object.entries(calibration.fixtures)
		.filter(([, fixture]) => fixture.layer === "regression" || fixture.tier === 1)
		.map(([id]) => id)
		.sort();
}

export type MissCause = "reviewer" | "critic" | "format";

export interface AcceptanceResult {
	readonly lane: string;
	readonly passed: boolean;
	readonly sameFixtureSet: boolean;
	readonly coreFixtures: number;
	readonly coreMisses: readonly { fixtureId: string; draw: number; cause: MissCause }[];
	readonly falsePositives: readonly { fixtureId: string; draw: number }[];
	readonly invalidNegatives: readonly { fixtureId: string; draw: number }[];
}

// Accepts reports from a later fixture set as long as every core fixture is
// present, so a contract change (new holdout) does not strand the core list.
export function acceptance(calibration: Calibration, report: Report): AcceptanceResult {
	const error = reportAdmissionError(report);
	if (error) throw new Error(`${laneKey(report)}: ${error}`);
	const core = new Set(coreFixtureIds(calibration));
	const present = new Set(report.results.map((result) => result.fixtureId));
	const absent = [...core].filter((id) => !present.has(id));
	if (absent.length)
		throw new Error(`${laneKey(report)}: missing core fixtures ${absent.join(", ")}`);
	const coreMisses = report.results
		.filter((result) => core.has(result.fixtureId) && !result.score.recall)
		.map((result) => ({
			fixtureId: result.fixtureId,
			draw: result.draw,
			cause: (!result.score.formatOk
				? "format"
				: result.score.criticPruneError
					? "critic"
					: "reviewer") as MissCause,
		}));
	const falsePositives = report.results
		.filter((result) => !isPositive(result) && result.score.falsePositive)
		.map((result) => ({ fixtureId: result.fixtureId, draw: result.draw }));
	// A negative with unusable output reviewed nothing; it is not a clean pass.
	const invalidNegatives = report.results
		.filter((result) => !isPositive(result) && !result.score.formatOk)
		.map((result) => ({ fixtureId: result.fixtureId, draw: result.draw }));
	return {
		lane: laneKey(report),
		passed:
			coreMisses.length === 0 &&
			falsePositives.length === 0 &&
			invalidNegatives.length === 0,
		sameFixtureSet: report.fixtureSetHash === calibration.fixtureSetHash,
		coreFixtures: core.size,
		coreMisses,
		falsePositives,
		invalidNegatives,
	};
}

// Lanes no other lane beats on both weighted recall and wall time.
export function paretoFrontier(scores: readonly LaneScore[]): Set<string> {
	return new Set(
		scores
			.filter(
				(a) =>
					!scores.some(
						(b) =>
							b !== a &&
							b.weightedRecall >= a.weightedRecall &&
							b.meanSecondsPerDraw <= a.meanSecondsPerDraw &&
							(b.weightedRecall > a.weightedRecall ||
								b.meanSecondsPerDraw < a.meanSecondsPerDraw),
					),
			)
			.map((score) => score.lane),
	);
}
