import { criticValueAggregates, type CriticDrawFields, type CriticValueAggregates } from "./critic-value";
import type { Aggregates, DrawResult, FixtureSpec } from "./types";

interface ReviewFamilyAggregates {
	readonly recallByDefectClass: Readonly<Record<string, number>>;
	readonly lineAnchorValidRateByDefectClass: Readonly<Record<string, number>>;
}

export function aggregateMustFindHitRates(
	results: readonly {
		readonly fixtureId: string;
		readonly score: Pick<DrawResult["score"], "mustFindHits" | "mustFindTotal">;
	}[],
): Pick<Aggregates, "mustFindHitRateByFixture" | "mustFindHitRate"> {
	const rates = new Map<string, number[]>();
	for (const result of results) {
		if (result.score.mustFindTotal === 0) continue;
		const fixtureRates = rates.get(result.fixtureId) ?? [];
		fixtureRates.push(result.score.mustFindHits / result.score.mustFindTotal);
		rates.set(result.fixtureId, fixtureRates);
	}
	const mustFindHitRateByFixture = Object.fromEntries(
		[...rates].map(([fixtureId, fixtureRates]) => [
			fixtureId,
			fixtureRates.reduce((sum, rate) => sum + rate, 0) / fixtureRates.length,
		]),
	);
	const fixtureRates = Object.values(mustFindHitRateByFixture);
	const mustFindHitRate = fixtureRates.length
		? fixtureRates.reduce((sum, rate) => sum + rate, 0) / fixtureRates.length
		: 0;
	return { mustFindHitRateByFixture, mustFindHitRate };
}

export function aggregateDefectClassMetrics(
	results: readonly {
		readonly fixtureId: string;
		readonly score: Pick<DrawResult["score"], "recall" | "lineAnchorValid">;
	}[],
	specs: readonly Pick<FixtureSpec, "id" | "kind" | "defectClass">[],
): {
	readonly recallByDefectClass: Readonly<Record<string, number>>;
	readonly lineAnchorValidRateByDefectClass: Readonly<Record<string, number>>;
} {
	const positiveByFixture = new Map(
		specs.filter((spec) => spec.kind === "positive").map((spec) => [spec.id, spec.defectClass]),
	);
	const output: Record<string, { total: number; recall: number; anchored: number }> = {};
	for (const result of results) {
		const defectClass = positiveByFixture.get(result.fixtureId);
		if (defectClass === undefined) continue;
		const bucket = output[defectClass] ?? { total: 0, recall: 0, anchored: 0 };
		bucket.total += 1;
		if (result.score.recall) bucket.recall += 1;
		if (result.score.lineAnchorValid) bucket.anchored += 1;
		output[defectClass] = bucket;
	}
	return {
		recallByDefectClass: Object.fromEntries(
			Object.entries(output).map(([defectClass, bucket]) => [
				defectClass,
				bucket.recall / bucket.total,
			]),
		),
		lineAnchorValidRateByDefectClass: Object.fromEntries(
			Object.entries(output).map(([defectClass, bucket]) => [
				defectClass,
				bucket.anchored / bucket.total,
			]),
		),
	};
}

export function aggregate(
	results: readonly (DrawResult & CriticDrawFields)[],
	specs: readonly FixtureSpec[],
): Aggregates & ReviewFamilyAggregates & CriticValueAggregates {
	const kindByFixture = new Map(specs.map((s) => [s.id, s.kind]));
	const tierByFixture = new Map(specs.map((s) => [s.id, s.tier ?? 2]));
	const positiveResults = results.filter(
		(r) => kindByFixture.get(r.fixtureId) === "positive",
	);
	const negativeResults = results.filter(
		(r) => kindByFixture.get(r.fixtureId) === "negative",
	);
	const recall = positiveResults.length
		? positiveResults.filter((r) => r.score.recall).length /
			positiveResults.length
		: 0;
	const falsePositiveRate = negativeResults.length
		? negativeResults.filter((r) => r.score.falsePositive).length /
			negativeResults.length
		: 0;
	const invalidJsonRate =
		results.filter((r) => !r.score.formatOk).length / results.length;
	const verdictMatchRate =
		results.filter((r) => r.score.verdictMatch).length / results.length;
	const lineAnchorValidRate =
		results.filter((r) => r.score.lineAnchorValid).length / results.length;
	const meanDurationMs =
		results.reduce((sum, r) => sum + r.durationMs, 0) / (results.length || 1);
	const criticPruneErrorRate = positiveResults.length
		? positiveResults.filter((r) => r.score.criticPruneError).length /
			positiveResults.length
		: 0;
	const recallByFixture: Record<string, number> = {};
	for (const id of new Set(results.map((r) => r.fixtureId))) {
		const draws = results.filter((r) => r.fixtureId === id);
		recallByFixture[id] =
			draws.filter((r) => r.score.recall).length / draws.length;
	}
	const recallByTier: Record<string, number> = {};
	for (const tier of [1, 2, 3]) {
		const tierResults = positiveResults.filter(
			(r) => tierByFixture.get(r.fixtureId) === tier,
		);
		if (tierResults.length === 0) continue;
		recallByTier[`t${tier}`] =
			tierResults.filter((r) => r.score.recall).length / tierResults.length;
	}
	const {
		recallByDefectClass,
		lineAnchorValidRateByDefectClass,
	} = aggregateDefectClassMetrics(results, specs);
	const meanNoisePerPositive = positiveResults.length
		? positiveResults.reduce((sum, r) => sum + r.score.noiseFindingCount, 0) /
			positiveResults.length
		: 0;
	const cheatDetectedCount = results.filter(
		(r) => r.score.cheatDetected,
	).length;
	const baitExposureCount = results.filter((r) => r.score.baitExposed).length;
	const criticPrunedRecallCount = results.reduce(
		(sum, result) =>
			sum +
			(result.matchEvidence ?? []).filter(
				(evidence, index) =>
					evidence.findingIndex === null &&
					result.candidateMatchEvidence?.[index]?.findingIndex !== null &&
					result.candidateMatchEvidence?.[index]?.findingIndex !== undefined,
			).length,
		0,
	);
	const mustFindHitRates = aggregateMustFindHitRates(results);
	return {
		recall,
		falsePositiveRate,
		invalidJsonRate,
		verdictMatchRate,
		lineAnchorValidRate,
		meanDurationMs,
		recallByFixture,
		...mustFindHitRates,
		criticPruneErrorRate,
		recallByTier,
		recallByDefectClass,
		lineAnchorValidRateByDefectClass,
		meanNoisePerPositive,
		cheatDetectedCount,
		baitExposureCount,
		criticPrunedRecallCount,
		...criticValueAggregates(results, specs),
	};
}
