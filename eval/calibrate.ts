import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	acceptance,
	buildCalibration,
	paretoFrontier,
	scoreLane,
	type AcceptanceResult,
	type Calibration,
	type LaneScore,
} from "./shared/calibration";
import { fixtureSetHash, loadFixtures } from "./shared/fixture-catalog";
import { promptHash } from "./shared/prompt-hash";
import type { Report } from "./shared/types";

const USAGE = `usage:
  calibrate.ts build [--out <file>] <report.json>...
  calibrate.ts score --calibration <file> <report.json>...
  calibrate.ts accept --calibration <file> <report.json>...

build   derives per-fixture difficulty from same-contract lanes (default out:
        eval/calibration/<fixtureSetHash>-<promptHash>.json)
score   offline difficulty-weighted, partial-credit, and per-stage scores;
        diagnostic only, never a gate
accept  core acceptance: every zoo-saturated or Tier-1 positive hit on every
        draw, at most 2 false positives pooled across negatives, no
        unusable negative output; misses split reviewer/critic/format
        (exit 2 on any failure). Needs a single Class R x3 run of the
        checked-out prompt over the current fixture catalog; refuses
        --fixtures, holdout subsets, and merged reports. Current Tier-1
        fixtures are core even if the calibration predates them.
`;

function readReport(file: string): Report {
	return JSON.parse(readFileSync(file, "utf8")) as Report;
}

function pct(value: number | null): string {
	return value === null ? "   -" : `${(value * 100).toFixed(1).padStart(5)}`;
}

export function renderScores(calibration: Calibration, scores: readonly LaneScore[]): string {
	const frontier = paretoFrontier(scores);
	const sorted = [...scores].sort((a, b) => b.weightedRecall - a.weightedRecall);
	const discriminating = Object.values(calibration.fixtures).filter(
		(fixture) => fixture.layer === "discriminating",
	).length;
	const lines = [
		`calibration ${calibration.fixtureSetHash}/${calibration.promptHash} · ${calibration.lanes.length} lanes · ${discriminating}/${Object.keys(calibration.fixtures).length} discriminating positives`,
		"lane | weighted | partial | binary | disc | t1 | reviewer | critic keep | noise | fp | op-fail | s/draw | pareto",
		"--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | ---",
	];
	for (const score of sorted) {
		lines.push(
			[
				`${score.lane}${score.leaveOneOut ? "" : " (held out)"}${score.promptHash === calibration.promptHash ? "" : " [other prompt]"}`,
				pct(score.weightedRecall),
				pct(score.partialRecall),
				pct(score.binaryRecall),
				pct(score.discriminatingRecall),
				pct(score.tier1Recall),
				pct(score.reviewerRecall),
				pct(score.criticRetention),
				score.noisePerPositive.toFixed(3),
				pct(score.falsePositiveRate),
				pct(score.operationalFailureRate),
				score.meanSecondsPerDraw.toFixed(0),
				frontier.has(score.lane) ? "yes" : "",
			].join(" | "),
		);
	}
	return lines.join("\n") + "\n";
}

export function renderAcceptance(results: readonly AcceptanceResult[]): string {
	const lines: string[] = [];
	for (const result of results) {
		const causes = result.coreMisses.reduce<Record<string, number>>((acc, miss) => {
			acc[miss.cause] = (acc[miss.cause] ?? 0) + 1;
			return acc;
		}, {});
		lines.push(
			`${result.passed ? "PASS" : "FAIL"} ${result.lane}${result.sameFixtureSet ? "" : " [later fixture set]"} · core ${result.coreFixtures} fixtures · misses ${result.coreMisses.length} ${JSON.stringify(causes)} · false positives ${result.falsePositives.length} · invalid negatives ${result.invalidNegatives.length}`,
		);
		for (const miss of result.coreMisses)
			lines.push(`  miss ${miss.fixtureId} draw ${miss.draw} (${miss.cause})`);
		for (const fp of result.falsePositives)
			lines.push(`  fp   ${fp.fixtureId} draw ${fp.draw}`);
		for (const bad of result.invalidNegatives)
			lines.push(`  invalid ${bad.fixtureId} draw ${bad.draw}`);
	}
	return lines.join("\n") + "\n";
}

export function renderFixtures(calibration: Calibration): string {
	const rows = Object.entries(calibration.fixtures).sort(
		([, a], [, b]) => b.difficulty - a.difficulty,
	);
	const lines = ["fixture | tier | difficulty | discrimination | layer"];
	for (const [id, fixture] of rows) {
		if (fixture.layer !== "discriminating") continue;
		lines.push(
			`${id} | ${fixture.tier ?? "-"} | ${fixture.difficulty.toFixed(3)} | ${fixture.discrimination === null ? "-" : fixture.discrimination.toFixed(2)} | ${fixture.layer}`,
		);
	}
	const saturated = rows.filter(([, fixture]) => fixture.layer === "regression");
	lines.push(`regression layer (${saturated.length}): ${saturated.map(([id]) => id).join(", ")}`);
	return lines.join("\n") + "\n";
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	let out: string | null = null;
	let calibrationPath: string | null = null;
	const files: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--out") out = rest[++i] ?? null;
		else if (rest[i] === "--calibration") calibrationPath = rest[++i] ?? null;
		else files.push(rest[i]);
	}
	if (files.length === 0) {
		process.stderr.write(USAGE);
		return 1;
	}
	const reports = files.map(readReport);
	if (command === "build") {
		const calibration = buildCalibration(reports);
		const target =
			out ??
			path.join(
				path.dirname(fileURLToPath(import.meta.url)),
				"calibration",
				`${calibration.fixtureSetHash}-${calibration.promptHash}.json`,
			);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, JSON.stringify(calibration, null, 2) + "\n");
		process.stdout.write(renderFixtures(calibration));
		process.stdout.write(`wrote ${target}\n`);
		return 0;
	}
	if (command === "accept" && calibrationPath) {
		const calibration = JSON.parse(readFileSync(calibrationPath, "utf8")) as Calibration;
		const current = {
			fixtureSetHash: fixtureSetHash(await loadFixtures(null)),
			promptHash: promptHash(),
		};
		const results = reports.map((report) => acceptance(calibration, report, current));
		process.stdout.write(renderAcceptance(results));
		return results.every((result) => result.passed) ? 0 : 2;
	}
	if (command === "score" && calibrationPath) {
		const calibration = JSON.parse(readFileSync(calibrationPath, "utf8")) as Calibration;
		process.stdout.write(renderScores(calibration, reports.map((report) => scoreLane(calibration, report))));
		return 0;
	}
	process.stderr.write(USAGE);
	return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		process.stderr.write(`calibrate: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(1);
	}
}
