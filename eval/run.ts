import {
	readdirSync,
	readFileSync,
	writeFileSync,
	existsSync,
	mkdirSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git } from "../src/shared/repo";
import { review } from "../src/core/review";
import { parseRunnerName, type RunnerName } from "../src/shared/runner";
import type { ReviewResult } from "../src/shared/schema";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { score } from "./shared/score";
import {
	ANTICHEAT_VERSION,
	type Aggregates,
	type DrawResult,
	type FixtureKind,
	type FixtureSpec,
	type HoldoutMode,
	type Report,
} from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const FIXTURES_REAL_DIR = path.join(__dirname, "fixtures-real");

interface RunArgs {
	runner: RunnerName;
	model: string | null;
	effort: string | null;
	draws: number;
	concurrency: number;
	baseline: boolean;
	report: string;
	dryRun: boolean;
	compare: string | null;
	fixtures: string | null;
	resume: string | null;
	holdout: HoldoutMode;
	env: Record<string, string>;
}

export async function mapLimit<T, R>(
	items: readonly T[],
	limit: number,
	fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from(
		{ length: Math.max(1, Math.min(limit, items.length)) },
		async () => {
			while (next < items.length) {
				const i = next++;
				results[i] = await fn(items[i], i);
			}
		},
	);
	await Promise.all(workers);
	return results;
}

export function parseArgs(argv: readonly string[]): RunArgs {
	const get = (flag: string): string | null => {
		const i = argv.indexOf(flag);
		return i >= 0 ? (argv[i + 1] ?? null) : null;
	};
	const runner = parseRunnerName(get("--runner") ?? "codex", "--runner");
	const model = get("--model");
	const effort = get("--effort");
	const draws = Number(get("--draws") ?? "1");
	if (!Number.isInteger(draws) || draws < 1)
		throw new Error("--draws must be a positive integer");
	const concurrencyIdx = argv.indexOf("--concurrency");
	let concurrency = 4;
	if (concurrencyIdx >= 0) {
		const raw = argv[concurrencyIdx + 1];
		if (raw === undefined || raw.startsWith("--"))
			throw new Error("--concurrency must be a positive integer");
		concurrency = Number(raw);
		if (!Number.isInteger(concurrency) || concurrency < 1)
			throw new Error("--concurrency must be a positive integer");
	}
	const baseline = argv.includes("--baseline");
	const dryRun = argv.includes("--dry-run");
	const report =
		get("--report") ??
		`eval/reports/${runner}${model ? "-" + model.replace(/[^\w.-]/g, "_") : ""}.json`;
	const compare = get("--compare");
	const fixtures = get("--fixtures");
	const resume = get("--resume");
	const holdoutRaw = get("--holdout") ?? "include";
	if (
		holdoutRaw !== "include" &&
		holdoutRaw !== "exclude" &&
		holdoutRaw !== "only"
	) {
		throw new Error(
			`--holdout must be include|exclude|only, got: ${holdoutRaw}`,
		);
	}
	const holdout = holdoutRaw as HoldoutMode;
	const env: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] !== "--env") continue;
		const raw = argv[i + 1];
		if (!raw) throw new Error("--env requires KEY=VALUE");
		const eq = raw.indexOf("=");
		if (eq <= 0) throw new Error(`--env requires KEY=VALUE, got: ${raw}`);
		env[raw.slice(0, eq)] = raw.slice(eq + 1);
		i++;
	}
	return {
		runner,
		model,
		effort,
		draws,
		concurrency,
		baseline,
		report,
		dryRun,
		compare,
		fixtures,
		resume,
		holdout,
		env,
	};
}

async function loadFixturesFrom(
	dirPath: string,
	glob: string | null,
): Promise<FixtureSpec[]> {
	const dirs = readdirSync(dirPath, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.filter((name) => (glob ? new RegExp(glob).test(name) : true))
		.sort();
	const specs: FixtureSpec[] = [];
	for (const dir of dirs) {
		const specPath = path.join(dirPath, dir, "spec.ts");
		if (!existsSync(specPath)) continue;
		const mod = await import(pathToFileURL(specPath).href);
		if (mod.default) specs.push(mod.default as FixtureSpec);
	}
	return specs;
}

export async function loadFixtures(
	glob: string | null,
): Promise<FixtureSpec[]> {
	const specs = await loadFixturesFrom(FIXTURES_DIR, glob);
	if (!existsSync(FIXTURES_REAL_DIR)) return specs;
	return [...specs, ...(await loadFixturesFrom(FIXTURES_REAL_DIR, glob))];
}

// Holdout filtering is a pure post-load step so plain runs always tell the
// full truth (include), prompt-tuning iteration can hide sealed holdouts
// (exclude), and final gates can run just the holdouts (only).
export function filterByHoldout(
	specs: readonly FixtureSpec[],
	mode: HoldoutMode,
): FixtureSpec[] {
	if (mode === "include") return [...specs];
	if (mode === "only") return specs.filter((s) => s.holdout === true);
	return specs.filter((s) => s.holdout !== true);
}

async function runOne(
	spec: FixtureSpec,
	runner: RunnerName,
	model: string | null,
	effort: string | null,
	dryRun: boolean,
	canary: string,
): Promise<DrawResult> {
	const loaded = loadFixture(spec, canary);
	const start = Date.now();
	let result: ReviewResult | null = null;
	let error: string | undefined;
	let failedOutput: string | undefined;
	try {
		if (dryRun) {
			error = "dry-run";
		} else {
			result = await review(loaded.bundle, {
				runner,
				model: model ?? undefined,
				reasoningEffort: effort ?? undefined,
			});
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		// runJsonPrompt rides EVERY failed attempt's raw output along on parse
		// failures — the canary scan must see them all (neither invalid output
		// nor a cleaner retry is an escape hatch).
		failedOutput = (
			err as Error & { rawOutputs?: readonly string[] }
		).rawOutputs?.join("\n");
	} finally {
		loaded.cleanup();
	}
	const durationMs = Date.now() - start;
	const stats = result?.stats;
	const calls = stats?.length ?? 0;
	const retries = stats?.reduce((sum, s) => sum + (s.attempts - 1), 0) ?? 0;
	return {
		fixtureId: spec.id,
		draw: 0,
		score: score(result, spec.expected, spec.id, error, canary, failedOutput),
		durationMs,
		calls,
		retries,
	};
}

interface DrawWork {
	readonly spec: FixtureSpec;
	readonly draw: number;
}

function buildWorkList(
	specs: readonly FixtureSpec[],
	draws: number,
): DrawWork[] {
	const work: DrawWork[] = [];
	for (const spec of specs) {
		for (let draw = 0; draw < draws; draw++) {
			work.push({ spec, draw });
		}
	}
	return work;
}

function completedResults(slots: readonly (DrawResult | null)[]): DrawResult[] {
	return slots.filter((r): r is DrawResult => r !== null);
}

export function resumeSlots(
	args: RunArgs,
	specs: readonly FixtureSpec[],
	work: readonly DrawWork[],
): { slots: (DrawResult | null)[]; skipped: number } {
	const slots: (DrawResult | null)[] = new Array(work.length).fill(null);
	let skipped = 0;
	if (!args.resume) return { slots, skipped };
	try {
		const existing = JSON.parse(readFileSync(args.resume, "utf8")) as Report;
		// Refuse to reuse draws produced under a different prompt or fixture set —
		// silently mixing them would fabricate a report no run ever produced.
		if (existing.promptHash !== promptHash()) {
			process.stderr.write(
				`resume: prompt hash mismatch (${existing.promptHash} vs ${promptHash()}), ignoring resume file\n`,
			);
			return { slots, skipped };
		}
		const currentFixtureHash = fixtureSetHash(specs);
		if (existing.fixtureSetHash !== currentFixtureHash) {
			process.stderr.write(
				`resume: fixture set hash mismatch (${existing.fixtureSetHash} vs ${currentFixtureHash}), ignoring resume file\n`,
			);
			return { slots, skipped };
		}
		// Draws from before the anti-cheat guards (or from an older guard
		// generation) were never subjected to canary detection — reusing them
		// would produce a "guarded" report whose numbers never faced the guard.
		if (existing.anticheatVersion !== ANTICHEAT_VERSION) {
			process.stderr.write(
				`resume: anti-cheat version mismatch (${existing.anticheatVersion ?? "none"} vs ${ANTICHEAT_VERSION}), ignoring resume file\n`,
			);
			return { slots, skipped };
		}
		// A fired trap voids the whole report (see cheatAlert) — none of its
		// draws may seed a fresh one. Fail closed on a MISSING count too:
		// unvalidated JSON, and absence of the canary result cannot establish
		// a clean report.
		if (
			typeof (existing.aggregates.cheatDetectedCount as number | undefined) !==
				"number" ||
			existing.aggregates.cheatDetectedCount !== 0
		) {
			process.stderr.write(
				`resume: report is compromised or unverifiable (cheatDetectedCount=${existing.aggregates.cheatDetectedCount ?? "missing"}), ignoring resume file\n`,
			);
			return { slots, skipped };
		}
		const byFixture = new Map<string, DrawResult[]>();
		for (const r of existing.results) {
			const arr = byFixture.get(r.fixtureId) ?? [];
			arr.push(r);
			byFixture.set(r.fixtureId, arr);
		}
		const doneFixtures = new Set<string>();
		for (const spec of specs) {
			const draws = byFixture.get(spec.id) ?? [];
			const good = draws.filter((d) => d.score.formatOk);
			if (good.length >= args.draws) {
				doneFixtures.add(spec.id);
				skipped++;
			}
		}
		for (let i = 0; i < work.length; i++) {
			const { spec, draw } = work[i];
			if (!doneFixtures.has(spec.id)) continue;
			const good = (byFixture.get(spec.id) ?? []).filter(
				(d) => d.score.formatOk,
			);
			slots[i] = {
				...good[draw],
				draw,
				calls: good[draw].calls ?? 0,
				retries: good[draw].retries ?? 0,
			};
		}
		process.stderr.write(
			`resume: reused ${skipped} fixture(s) with ${args.draws} good draws, re-running the rest\n`,
		);
	} catch (err) {
		process.stderr.write(
			`resume: could not load ${args.resume} (${err instanceof Error ? err.message : err}), starting fresh\n`,
		);
	}
	return { slots, skipped };
}

async function runWork(
	args: RunArgs,
	work: readonly DrawWork[],
	slots: (DrawResult | null)[],
	canary: string,
	onDrawComplete?: (results: readonly DrawResult[]) => void,
): Promise<DrawResult[]> {
	const pending = work.map((_, i) => i).filter((i) => slots[i] === null);
	await mapLimit(pending, args.concurrency, async (idx) => {
		const { spec, draw } = work[idx];
		const r = await runOne(
			spec,
			args.runner,
			args.model,
			args.effort,
			args.dryRun,
			canary,
		);
		const result = { ...r, draw };
		slots[idx] = result;
		process.stderr.write(
			`  [${spec.id}] draw ${draw + 1}/${args.draws} ${r.score.formatOk ? "ok" : "FAIL"} (${r.durationMs}ms)\n`,
		);
		onDrawComplete?.(completedResults(slots));
		return result;
	});
	return slots.map((r, i) => {
		if (r === null)
			throw new Error(
				`missing draw result for ${work[i].spec.id} draw ${work[i].draw}`,
			);
		return r;
	});
}

// Stable 16-hex digest of the fixture set actually run. Two reports are only
// comparable when both promptHash and fixtureSetHash match.
export function fixtureSetHash(specs: readonly FixtureSpec[]): string {
	const canonical = [...specs]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((s) => ({
			id: s.id,
			kind: s.kind,
			tier: s.tier ?? null,
			baseFiles: s.baseFiles,
			...(s.deletedFiles && s.deletedFiles.length > 0
				? { deletedFiles: [...s.deletedFiles].sort() }
				: {}),
			...(s.renamedFiles && s.renamedFiles.length > 0
				? {
						renamedFiles: s.renamedFiles
							.map(({ from, to }) => ({ from, to }))
							.sort(
								(a, b) =>
									a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
							),
					}
				: {}),
			headFiles: s.headFiles,
			expected: s.expected,
			holdout: s.holdout ?? false,
			provenance: s.provenance,
		}));
	return createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex")
		.slice(0, 16);
}

function repoGitSha(): string | null {
	try {
		return git(["rev-parse", "HEAD"], path.join(__dirname, "..")).trim();
	} catch {
		return null;
	}
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

function aggregate(
	results: readonly DrawResult[],
	specs: readonly FixtureSpec[],
): Aggregates {
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
	const meanNoisePerPositive = positiveResults.length
		? positiveResults.reduce((sum, r) => sum + r.score.noiseFindingCount, 0) /
			positiveResults.length
		: 0;
	const cheatDetectedCount = results.filter(
		(r) => r.score.cheatDetected,
	).length;
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
		meanNoisePerPositive,
		cheatDetectedCount,
	};
}

export function writeReport(
	args: RunArgs,
	results: readonly DrawResult[],
	specs: readonly FixtureSpec[],
): Report & {
	readonly fixtures: readonly string[];
	readonly fixtureKinds: Readonly<Record<string, FixtureKind>>;
} {
	const fixtureTiers: Record<string, number> = {};
	const fixtureKinds: Record<string, FixtureKind> = {};
	for (const s of specs) {
		if (s.kind === "positive") fixtureTiers[s.id] = s.tier ?? 2;
		fixtureKinds[s.id] = s.kind;
	}
	const report = {
		promptHash: promptHash(),
		runner: args.runner,
		model: args.model,
		effort: args.effort,
		draws: args.draws,
		createdAt: new Date().toISOString(),
		baseline: args.baseline,
		holdout: args.holdout,
		results,
		aggregates: aggregate(results, specs),
		gitSha: repoGitSha(),
		fixtureSetHash: fixtureSetHash(specs),
		fixtureTiers,
		// The version label is a promise that every generation-1 guard was on:
		// HOME isolation AND eval tracing (without the trace, critic-pruned
		// candidates and failed raw outputs never reach the canary scan). A user
		// --env override can legitimately disable either (e.g. acp lanes) — such
		// a report is honestly unversioned, so resume/compare refuse it instead
		// of trusting a label the run didn't earn. The claude runner is exempt
		// from HOME isolation by design (Keychain auth cannot be staged), so a
		// claude lane never earns the label either — certifying it would promise
		// a G1 guarantee its draws did not have. Dry runs never invoke a model,
		// so they cannot earn a generation label even when both flags are set.
		...(!args.dryRun &&
			args.runner !== "claude" &&
			process.env.NEEDLEFISH_EPHEMERAL_HOME === "1" &&
			process.env.NEEDLEFISH_EVAL_TRACE === "1"
			? { anticheatVersion: ANTICHEAT_VERSION }
			: {}),
		fixtures: specs.map((spec) => spec.id),
		fixtureKinds,
	} satisfies Report & {
		readonly fixtures: readonly string[];
		readonly fixtureKinds: Readonly<Record<string, FixtureKind>>;
	};
	mkdirSync(path.dirname(path.resolve(args.report)), { recursive: true });
	writeFileSync(args.report, JSON.stringify(report, null, 2));
	return report;
}

export function compare(baselinePath: string, candidate: Report): void {
	const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Report;
	if (baseline.promptHash !== candidate.promptHash) {
		throw new Error(
			`prompt hash mismatch: baseline ${baseline.promptHash} vs candidate ${candidate.promptHash}. Re-run baseline after prompt changes.`,
		);
	}
	if (baseline.fixtureSetHash === undefined) {
		throw new Error(
			"baseline report is missing fixtureSetHash. Re-run baseline with the current eval harness.",
		);
	}
	if (candidate.fixtureSetHash === undefined) {
		throw new Error(
			"candidate report is missing fixtureSetHash. Re-run candidate with the current eval harness.",
		);
	}
	if (baseline.fixtureSetHash !== candidate.fixtureSetHash) {
		throw new Error(
			`fixture set hash mismatch: baseline ${baseline.fixtureSetHash} vs candidate ${candidate.fixtureSetHash}. Re-run baseline after fixture changes.`,
		);
	}
	if (baseline.holdout !== candidate.holdout) {
		throw new Error(
			`holdout mode mismatch: baseline ran '${baseline.holdout}', candidate ran '${candidate.holdout}'. Deltas across different subsets are meaningless.`,
		);
	}
	// Draws from another anti-cheat generation never faced the same guards —
	// presenting them as comparable would let an unguarded baseline anchor a
	// guarded candidate (or vice versa). Deliberate cross-generation studies
	// read the reports directly instead of using --compare.
	for (const [label, report] of [
		["baseline", baseline],
		["candidate", candidate],
	] as const) {
		if (report.anticheatVersion !== ANTICHEAT_VERSION) {
			throw new Error(
				`${label} report anti-cheat version is ${report.anticheatVersion ?? "none"}, current is ${ANTICHEAT_VERSION}. Re-run the ${label} under the current guards.`,
			);
		}
		// A fired trap voids the whole report (see cheatAlert) — void numbers
		// cannot anchor or pass a comparison. A MISSING count fails closed too:
		// unvalidated JSON, and absence of the canary result cannot establish
		// a clean report.
		if (
			typeof (report.aggregates.cheatDetectedCount as number | undefined) !==
				"number" ||
			report.aggregates.cheatDetectedCount !== 0
		) {
			throw new Error(
				`${label} report is compromised or unverifiable (cheatDetectedCount=${report.aggregates.cheatDetectedCount ?? "missing"}). Investigate the runner sandbox and re-run the ${label}.`,
			);
		}
	}
	const b = baseline.aggregates;
	const c = candidate.aggregates;
	const delta = (x: number, y: number) => y - x;
	const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
	const lines = [
		`compare: ${candidate.runner}${candidate.model ? "/" + candidate.model : ""}${candidate.effort ? ` @${candidate.effort}` : ""} vs baseline ${baseline.runner}`,
		`prompt-hash: ${candidate.promptHash} (matched)`,
		`  recall:                ${pct(c.recall)} (baseline ${pct(b.recall)}, Δ ${pct(delta(b.recall, c.recall))})`,
		`  falsePositiveRate:     ${pct(c.falsePositiveRate)} (baseline ${pct(b.falsePositiveRate)}, Δ ${pct(delta(b.falsePositiveRate, c.falsePositiveRate))})`,
		`  invalidJsonRate:       ${pct(c.invalidJsonRate)} (baseline ${pct(b.invalidJsonRate)}, Δ ${pct(delta(b.invalidJsonRate, c.invalidJsonRate))})`,
		`  verdictMatchRate:      ${pct(c.verdictMatchRate)} (baseline ${pct(b.verdictMatchRate)}, Δ ${pct(delta(b.verdictMatchRate, c.verdictMatchRate))})`,
		`  lineAnchorValidRate:   ${pct(c.lineAnchorValidRate)} (baseline ${pct(b.lineAnchorValidRate)}, Δ ${pct(delta(b.lineAnchorValidRate, c.lineAnchorValidRate))})`,
		`  meanDurationMs:        ${c.meanDurationMs.toFixed(0)} (baseline ${b.meanDurationMs.toFixed(0)})`,
	];
	process.stdout.write(lines.join("\n") + "\n");
}

// A fired honeypot trap means the runner produced text it could only have
// gotten from the spec file (answer key). The whole report is compromised —
// scream, don't bury it in an aggregate field nobody reads.
export function cheatAlert(report: Report): void {
	if (report.aggregates.cheatDetectedCount === 0) return;
	process.stderr.write(
		`\nCHEAT ALERT: honeypot trap matched in ${report.aggregates.cheatDetectedCount} draw(s). ` +
			`The runner referenced content that exists only in fixture spec files. ` +
			`Treat every number in this report as compromised and investigate the runner sandbox.\n\n`,
	);
	// A compromised report must also fail the command: the report stays on
	// disk for diagnosis, but no caller (CI gate, compare, scripts) may see
	// this run exit 0.
	process.exitCode = 1;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	// Eval-integrity guards, applied once here (not per-draw) alongside user
	// --env overrides, and restored in finally. A user `--env KEY=...` wins.
	// - NEEDLEFISH_EVAL_TRACE: critic prune-error trace.
	// - NEEDLEFISH_EPHEMERAL_HOME: per-draw isolated HOME for runner subprocesses
	//   (G1); eval always isolates, prod CLI path stays opt-in.
	const envDefaults: Record<string, string> = {
		NEEDLEFISH_EVAL_TRACE: "1",
		NEEDLEFISH_EPHEMERAL_HOME: "1",
	};
	const envPrevious = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries({ ...envDefaults, ...args.env })) {
		envPrevious.set(key, process.env[key]);
		process.env[key] = value;
	}
	if (process.env.NEEDLEFISH_EPHEMERAL_HOME !== "1") {
		process.stderr.write(
			"WARNING: NEEDLEFISH_EPHEMERAL_HOME disabled via --env — draws run without HOME isolation; the report will carry no anticheatVersion and cannot be resumed or compared.\n",
		);
	}
	if (process.env.NEEDLEFISH_EVAL_TRACE !== "1") {
		process.stderr.write(
			"WARNING: NEEDLEFISH_EVAL_TRACE disabled via --env — critic-pruned candidates and failed raw outputs are invisible to the canary scan; the report will carry no anticheatVersion and cannot be resumed or compared.\n",
		);
	}
	if (args.runner === "claude") {
		process.stderr.write(
			"WARNING: the claude runner is exempt from ephemeral-HOME isolation (Keychain auth cannot be staged) — the report will carry no anticheatVersion and cannot be resumed or compared.\n",
		);
	}
	try {
		// Holdout discipline, machine-enforced: a baseline (the reference other
		// runs compare against) must tell the full truth — never a holdout-free
		// tuning subset frozen into a reference.
		if (args.baseline && args.holdout !== "include") {
			throw new Error(
				"--baseline requires --holdout include: a baseline recorded on a tuning subset is not a baseline",
			);
		}
		const loaded = await loadFixtures(args.fixtures);
		const specs = filterByHoldout(loaded, args.holdout);
		const work = buildWorkList(specs, args.draws);
		// Per-run canary (G3): a unique token embedded in the bait answer key.
		// Threaded through fixture materialization and scoring; a finding that
		// contains it means the runner copied the planted answer key.
		const canary = randomUUID();

		if (args.compare) {
			const slots: (DrawResult | null)[] = new Array(work.length).fill(null);
			const results = await runWork(args, work, slots, canary);
			const report = writeReport(args, results, specs);
			cheatAlert(report);
			compare(args.compare, report);
			return;
		}
		if (specs.length === 0) {
			process.stderr.write("no fixtures found\n");
			process.exit(1);
		}
		process.stderr.write(`prompt-hash: ${promptHash()}\n`);
		process.stderr.write(
			`fixtures: ${specs.length} | runner: ${args.runner} | model: ${args.model ?? "(default)"}${args.effort ? ` | effort: ${args.effort}` : ""} | draws: ${args.draws} | concurrency: ${args.concurrency} | holdout: ${args.holdout}${args.dryRun ? " | dry-run" : ""}\n`,
		);

		const { slots } = resumeSlots(args, specs, work);
		const onDrawComplete = args.resume
			? (partial: readonly DrawResult[]) => writeReport(args, partial, specs)
			: undefined;
		const results = await runWork(args, work, slots, canary, onDrawComplete);

		const report = writeReport(args, results, specs);
		cheatAlert(report);
		process.stderr.write(`report: ${args.report}\n`);
		process.stdout.write(
			JSON.stringify(
				{ promptHash: report.promptHash, aggregates: report.aggregates },
				null,
				2,
			) + "\n",
		);
	} finally {
		for (const [key, value] of envPrevious) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
	main().catch((err) => {
		process.stderr.write(
			`eval failed: ${err instanceof Error ? err.message : String(err)}\n`,
		);
		process.exit(1);
	});
}
