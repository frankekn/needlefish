import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	ANTICHEAT_VERSION,
	type FixtureSpec,
	type Report,
} from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

async function loadAll(): Promise<FixtureSpec[]> {
	const dirs = readdirSync(FIXTURES_DIR, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();
	const specs: FixtureSpec[] = [];
	for (const dir of dirs) {
		const specPath = path.join(FIXTURES_DIR, dir, "spec.ts");
		if (!existsSync(specPath)) continue;
		const mod = await import(pathToFileURL(specPath).href);
		if (mod.default) specs.push(mod.default as FixtureSpec);
	}
	return specs;
}

const baselinePath =
	process.argv[2] ??
	path.join(__dirname, "baselines", "codex-2d82256f1bb7da69.json");
const report = JSON.parse(readFileSync(baselinePath, "utf8")) as Report;
// Comparability contract, same as resume/compare/weekly/gen-results: baseline
// documentation must never be generated from an unguarded or compromised
// report — a missing cheatDetectedCount fails closed (unvalidated JSON).
const cheatCount = report.aggregates.cheatDetectedCount as number | undefined;
if (
	report.anticheatVersion !== ANTICHEAT_VERSION ||
	typeof cheatCount !== "number" ||
	cheatCount !== 0
) {
	process.stderr.write(
		`refusing to generate baseline doc: anticheatVersion=${report.anticheatVersion ?? "none"} (current ${ANTICHEAT_VERSION}), cheatDetectedCount=${cheatCount ?? "missing"} — re-run the baseline under the current guards\n`,
	);
	process.exit(1);
}
const specs = await loadAll();
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
	`- **fixtures:** ${report.results.length} (${specs.filter((s) => s.kind === "positive").length} positive, ${specs.filter((s) => s.kind === "negative").length} negative, ${specs.filter((s) => s.kind === "parity").length} parity)`,
);
lines.push(
	`- **report file:** \`eval/baselines/codex-${report.promptHash}.json\``,
);
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
lines.push(`  --compare eval/baselines/codex-${report.promptHash}.json \\`);
lines.push(`  --report eval/reports/<model>.json`);
lines.push(``);
lines.push(`# inspect raw findings for one fixture`);
lines.push(`node --import tsx eval/inspect.ts <fixture-id>`);
lines.push(`\`\`\``);
lines.push(``);
lines.push(`## Regenerate this doc`);
lines.push(``);
lines.push(`\`\`\`bash`);
lines.push(
	`node --import tsx eval/gen-baseline-doc.ts eval/baselines/codex-${report.promptHash}.json`,
);
lines.push(`\`\`\``);

writeFileSync(path.join(__dirname, "BASELINE.md"), lines.join("\n") + "\n");
process.stderr.write(`wrote eval/BASELINE.md (${lines.length} lines)\n`);
