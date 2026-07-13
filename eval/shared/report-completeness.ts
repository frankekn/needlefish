import type { Report } from "./types";

function uniqueNonEmptyIds(value: unknown): Set<string> | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const ids = new Set<string>();
	for (const id of value) {
		if (typeof id !== "string" || id.length === 0 || ids.has(id)) {
			return undefined;
		}
		ids.add(id);
	}
	return ids;
}

export function reportExpectedResultCount(report: Report): number | undefined {
	const fixtureIds = uniqueNonEmptyIds(report.fixtures);
	return fixtureIds !== undefined &&
		Number.isInteger(report.draws) &&
		report.draws > 0
		? fixtureIds.size * report.draws
		: undefined;
}

export function isCompleteReport(
	report: Report,
	expectedFixtureIds?: readonly string[],
): boolean {
	const fixtureIds = uniqueNonEmptyIds(report.fixtures);
	if (
		fixtureIds === undefined ||
		!Number.isInteger(report.draws) ||
		report.draws <= 0 ||
		!Array.isArray(report.results)
	) {
		return false;
	}

	if (expectedFixtureIds !== undefined) {
		const expected = uniqueNonEmptyIds(expectedFixtureIds);
		if (
			expected === undefined ||
			expected.size !== fixtureIds.size ||
			![...expected].every((id) => fixtureIds.has(id))
		) {
			return false;
		}
	}

	const covered = new Set<string>();
	for (const result of report.results) {
		if (
			typeof result !== "object" ||
			result === null ||
			!fixtureIds.has(result.fixtureId) ||
			!Number.isInteger(result.draw) ||
			result.draw < 0 ||
			result.draw >= report.draws
		) {
			return false;
		}
		const pair = JSON.stringify([result.fixtureId, result.draw]);
		if (covered.has(pair)) return false;
		covered.add(pair);
	}

	return covered.size === fixtureIds.size * report.draws;
}
