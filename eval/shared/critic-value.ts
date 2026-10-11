import type { ReviewResult } from "../../src/shared/schema";
import { score } from "./score";
import type { DrawResult, Expected, FixtureScore, FixtureSpec } from "./types";

// Lives outside score.ts/types.ts on purpose: those files feed scorerHash(),
// and editing them would orphan every existing report from --compare/--resume.

export type CandidateScore = Pick<
	FixtureScore,
	| "recall"
	| "falsePositive"
	| "noiseFindingCount"
	| "findingCount"
	| "blockingFindingCount"
>;

export interface CriticDrawFields {
	// Final-finding scoring rules applied to the pre-critic candidate list.
	// Absent when the review carried no candidateFindings (trace off, failed
	// or fast-path draws), never zero-filled.
	readonly candidateScore?: CandidateScore;
	readonly criticMs?: number;
	readonly totalPassMs?: number;
}

export interface CriticDelta {
	readonly falsePositiveRate?: number;
	readonly meanNoisePerPositive?: number;
	readonly recall?: number;
}

export interface CriticValueAggregates {
	readonly candidateFalsePositiveRate?: number;
	readonly candidateMeanNoisePerPositive?: number;
	// Final minus candidate over the same draws (those with a candidateScore),
	// so failed draws never enter one side only.
	readonly criticDelta?: CriticDelta;
	// Critic pass time over summed pass time. Deep passes run concurrently, so
	// the denominator is runner time, not wall-clock time.
	readonly criticTimeShare?: number;
}

type CriticValueDraw = Pick<DrawResult, "fixtureId" | "score"> & CriticDrawFields;

interface PairedDraw {
	readonly final: CandidateScore;
	readonly candidate: CandidateScore;
}

export function criticDrawFields(
	result: Pick<ReviewResult, "verdict" | "findings" | "candidateFindings" | "stats"> | null,
	expected: Expected,
	fixtureId: string,
): CriticDrawFields {
	const candidates = result?.candidateFindings;
	const stats = result?.stats;
	return {
		...(candidates
			? {
					candidateScore: pickCandidateScore(
						score({ verdict: result.verdict, findings: candidates }, expected, fixtureId),
					),
				}
			: {}),
		...(stats && stats.length > 0
			? {
					criticMs: sumMs(stats.filter((stat) => stat.label === "critic")),
					totalPassMs: sumMs(stats),
				}
			: {}),
	};
}

export function criticValueAggregates(
	results: readonly CriticValueDraw[],
	specs: readonly Pick<FixtureSpec, "id" | "kind">[],
): CriticValueAggregates {
	const kindByFixture = new Map(specs.map((spec) => [spec.id, spec.kind]));
	const pairedOfKind = (kind: FixtureSpec["kind"]): PairedDraw[] =>
		results.flatMap((result) =>
			result.candidateScore && kindByFixture.get(result.fixtureId) === kind
				? [{ final: result.score, candidate: result.candidateScore }]
				: [],
		);
	const negatives = pairedOfKind("negative");
	const positives = pairedOfKind("positive");
	const falsePositive = (scored: CandidateScore): number => Number(scored.falsePositive);
	const noise = (scored: CandidateScore): number => scored.noiseFindingCount;
	const recall = (scored: CandidateScore): number => Number(scored.recall);

	const criticDelta: CriticDelta = {
		...(negatives.length > 0
			? { falsePositiveRate: meanDelta(negatives, falsePositive) }
			: {}),
		...(positives.length > 0
			? {
					meanNoisePerPositive: meanDelta(positives, noise),
					recall: meanDelta(positives, recall),
				}
			: {}),
	};

	let criticMs = 0;
	let totalPassMs = 0;
	for (const result of results) {
		if (result.criticMs === undefined || result.totalPassMs === undefined) continue;
		criticMs += result.criticMs;
		totalPassMs += result.totalPassMs;
	}

	return {
		...(negatives.length > 0
			? { candidateFalsePositiveRate: mean(negatives, (d) => falsePositive(d.candidate)) }
			: {}),
		...(positives.length > 0
			? { candidateMeanNoisePerPositive: mean(positives, (d) => noise(d.candidate)) }
			: {}),
		...(Object.keys(criticDelta).length > 0 ? { criticDelta } : {}),
		...(totalPassMs > 0 ? { criticTimeShare: criticMs / totalPassMs } : {}),
	};
}

export function formatCriticValue(aggregates: CriticValueAggregates): string | null {
	const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
	const sign = (n: number): string => (n > 0 ? "+" : "");
	const delta = aggregates.criticDelta;
	const lines = [
		aggregates.candidateFalsePositiveRate !== undefined
			? `  candidate falsePositiveRate:    ${pct(aggregates.candidateFalsePositiveRate)}${delta?.falsePositiveRate !== undefined ? ` (critic Δ ${sign(delta.falsePositiveRate)}${pct(delta.falsePositiveRate)})` : ""}`
			: null,
		aggregates.candidateMeanNoisePerPositive !== undefined
			? `  candidate meanNoisePerPositive: ${aggregates.candidateMeanNoisePerPositive.toFixed(2)}${delta?.meanNoisePerPositive !== undefined ? ` (critic Δ ${sign(delta.meanNoisePerPositive)}${delta.meanNoisePerPositive.toFixed(2)})` : ""}`
			: null,
		delta?.recall !== undefined
			? `  critic Δ recall:                ${sign(delta.recall)}${pct(delta.recall)}`
			: null,
		aggregates.criticTimeShare !== undefined
			? `  critic share of pass time:      ${pct(aggregates.criticTimeShare)}`
			: null,
	].filter((line): line is string => line !== null);
	return lines.length > 0 ? ["Critic value", ...lines].join("\n") : null;
}

function pickCandidateScore(scored: FixtureScore): CandidateScore {
	return {
		recall: scored.recall,
		falsePositive: scored.falsePositive,
		noiseFindingCount: scored.noiseFindingCount,
		findingCount: scored.findingCount,
		blockingFindingCount: scored.blockingFindingCount,
	};
}

function sumMs(stats: readonly { readonly durationMs: number }[]): number {
	return stats.reduce((sum, stat) => sum + stat.durationMs, 0);
}

function mean<T>(items: readonly T[], value: (item: T) => number): number {
	return items.reduce((sum, item) => sum + value(item), 0) / items.length;
}

function meanDelta(
	draws: readonly PairedDraw[],
	value: (scored: CandidateScore) => number,
): number {
	return mean(draws, (d) => value(d.final) - value(d.candidate));
}
