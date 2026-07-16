import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureSetHash, loadFixtures } from "./run";
import { isCompleteReport } from "./shared/report-completeness";
import { hasConsistentCheatDetection } from "./shared/report-integrity";
import { scorerHash } from "./shared/scorer-hash";
import { ANTICHEAT_VERSION, type Report } from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// No default report: every committed baseline predates the anti-cheat guards
// and would deterministically fail the gate below. The caller names the
// guarded baseline explicitly (see the invocation recorded at the bottom of
// eval/BASELINE.md) — a hardcoded default would just go stale again the next
// time the baseline is re-recorded.
const baselinePath = process.argv[2];
if (!baselinePath) {
	process.stderr.write(
		"usage: node --import tsx eval/gen-baseline-doc.ts <eval/baselines/<report>.json>\n",
	);
	process.exit(1);
}
const repoRoot = path.resolve(__dirname, "..");
const baselineAbsolutePath = path.resolve(baselinePath);
const baselineRelativePath = path.relative(repoRoot, baselineAbsolutePath);
const baselineDisplayPath =
	baselineRelativePath !== ".." &&
	!baselineRelativePath.startsWith(`..${path.sep}`) &&
	!path.isAbsolute(baselineRelativePath)
		? baselineRelativePath.split(path.sep).join("/")
		: baselineAbsolutePath;
const report = JSON.parse(readFileSync(baselineAbsolutePath, "utf8")) as Report;
const specs = await loadFixtures(null);
// Comparability contract, same as resume/compare/weekly/gen-results: baseline
// documentation must never be generated from an unguarded, compromised,
// incomplete, hashless, or filtered report. Unvalidated JSON fails closed.
const cheatCount = report.aggregates?.cheatDetectedCount as number | undefined;
const complete = isCompleteReport(
	report,
	specs.map((spec) => spec.id),
);
const expectedFixtureHash = fixtureSetHash(specs);
const promptHashOk =
	typeof report.promptHash === "string" && report.promptHash.length > 0;
const fixtureHashOk =
	typeof report.fixtureSetHash === "string" &&
	report.fixtureSetHash.length > 0 &&
	report.fixtureSetHash === expectedFixtureHash;
const runnerOk = report.runner === "codex";
const scorerHashOk =
	typeof report.scorerHash === "string" &&
	report.scorerHash.length > 0 &&
	report.scorerHash === scorerHash();
if (
	report.anticheatVersion !== ANTICHEAT_VERSION ||
	typeof cheatCount !== "number" ||
	cheatCount !== 0 ||
	!hasConsistentCheatDetection(report) ||
	!complete ||
	!promptHashOk ||
	!fixtureHashOk ||
	!scorerHashOk ||
	!runnerOk
) {
	process.stderr.write(
		`refusing to generate baseline doc: runner=${runnerOk ? "codex" : report.runner ?? "missing"}, anticheatVersion=${report.anticheatVersion ?? "none"} (current ${ANTICHEAT_VERSION}), cheatDetectedCount=${cheatCount ?? "missing"}, completeFullFixtureSet=${complete}, promptHash=${promptHashOk ? "ok" : "missing"}, fixtureSetHash=${fixtureHashOk ? "ok" : report.fixtureSetHash ?? "missing"}, scorerHash=${scorerHashOk ? "ok" : report.scorerHash ?? "missing"} — re-run the full Codex baseline under the current guards\n`,
	);
	process.exit(1);
}
const specById = new Map(specs.map((s) => [s.id, s]));

const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
const a = report.aggregates;
const lines: string[] = [];

lines.push(`# Codex Baseline — ${report.promptHash}`);
lines.push(``);
lines.push(
	`The reference numbers for the needlefish eval. All other runners/models report **delta vs this baseline** and must match the prompt-hash.`,
);
lines.push(``);
lines.push(`- **promptHash:** \`${report.promptHash}\``);
lines.push(
	`- **runner:** ${report.runner} | **model:** ${report.model ?? "(default)"}`,
);
lines.push(`- **draws:** ${report.draws}`);
lines.push(`- **created:** ${report.createdAt}`);
lines.push(
	`- **fixtures:** ${specs.length} (${specs.filter((s) => s.kind === "positive").length} positive, ${specs.filter((s) => s.kind === "negative").length} negative, ${specs.filter((s) => s.kind === "parity").length} parity)`,
);
lines.push(`- **report file:** \`${baselineDisplayPath}\``);
lines.push(``);
lines.push(`## Aggregates`);
lines.push(``);
lines.push(`| metric | value |`);
lines.push(`|---|---|`);
lines.push(`| recall | ${pct(a.recall)} |`);
lines.push(`| falsePositiveRate | ${pct(a.falsePositiveRate)} |`);
lines.push(`| invalidJsonRate | ${pct(a.invalidJsonRate)} |`);
lines.push(`| verdictMatchRate | ${pct(a.verdictMatchRate)} |`);
lines.push(`| lineAnchorValidRate | ${pct(a.lineAnchorValidRate)} |`);
lines.push(`| meanDurationMs | ${Math.round(a.meanDurationMs / 1000)}s |`);
lines.push(``);
lines.push(`## Fixture-level results`);
lines.push(``);
lines.push(`| fixture | kind | format | verdict | recall/fp | anchor | dur |`);
lines.push(`|---|---|---|---|---|---|---|`);
for (const r of report.results) {
	const spec = specById.get(r.fixtureId);
	const kind = spec?.kind ?? "?";
	const scoreCol =
		kind === "positive"
			? `recall=${r.score.recall}`
			: kind === "negative"
				? `fp=${r.score.falsePositive}`
				: `recall=${r.score.recall}`;
	lines.push(
		`| ${r.fixtureId} | ${kind} | ${r.score.formatOk ? "ok" : "FAIL"} | ${r.score.verdictMatch ? "match" : "miss"} | ${scoreCol} | ${r.score.lineAnchorValid ? "ok" : "off"} | ${Math.round(r.durationMs / 1000)}s |`,
	);
}
lines.push(``);
lines.push(`## Misses (positive, recall=false)`);
lines.push(``);
const misses = report.results.filter(
	(r) => specById.get(r.fixtureId)?.kind === "positive" && !r.score.recall,
);
if (misses.length === 0) lines.push(`(none)`);
for (const r of misses) {
	const spec = specById.get(r.fixtureId);
	lines.push(
		`- **${r.fixtureId}** — ${spec?.defectClass ?? ""}: ${spec?.description ?? ""}`,
	);
}
lines.push(``);
lines.push(`## False positives (negative, fp=true)`);
lines.push(``);
const fps = report.results.filter(
	(r) =>
		specById.get(r.fixtureId)?.kind === "negative" && r.score.falsePositive,
);
if (fps.length === 0) lines.push(`(none)`);
for (const r of fps) {
	const spec = specById.get(r.fixtureId);
	lines.push(
		`- **${r.fixtureId}** — ${spec?.defectClass ?? ""}: ${spec?.description ?? ""}`,
	);
}
lines.push(``);
lines.push(
	`> Single-draw variance: a miss/FP that does not reproduce on re-run is variance, not a stable gap. Use N=3 draws (Phase 4) to separate stable misses from noise. The \`go-harmless-variadic\` FP above did not reproduce on re-run via \`eval/inspect.ts\`.`,
);
lines.push(``);
lines.push(`## Reproduce`);
lines.push(``);
lines.push(`\`\`\`bash`);
lines.push(
	`# re-run this baseline (prompt must be unchanged for the same promptHash)`,
);
lines.push(
	`node --import tsx eval/run.ts --runner codex --baseline --draws 1 \\`,
);
lines.push(`  --report eval/reports/codex-baseline.json`);
lines.push(``);
lines.push(
	`# compare another model against this baseline (asserts same promptHash)`,
);
lines.push(
	`node --import tsx eval/run.ts --runner <codex|claude|opencode> --model <id> --draws 1 \\`,
);
lines.push(`  --compare ${baselineDisplayPath} \\`);
lines.push(`  --report eval/reports/<model>.json`);
lines.push(``);
lines.push(`# inspect raw findings for one fixture`);
lines.push(`node --import tsx eval/inspect.ts <fixture-id>`);
lines.push(`\`\`\``);
lines.push(``);
lines.push(`## Regenerate this doc`);
lines.push(``);
lines.push(`\`\`\`bash`);
lines.push(`node --import tsx eval/gen-baseline-doc.ts ${baselineDisplayPath}`);
lines.push(`\`\`\``);

writeFileSync(path.join(__dirname, "BASELINE.md"), lines.join("\n") + "\n");
process.stderr.write(`wrote eval/BASELINE.md (${lines.length} lines)\n`);
