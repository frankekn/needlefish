import {
	readdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { git } from "../src/shared/repo";
import { review } from "../src/core/review";
import type { ReviewTraceEvent } from "../src/core/review-trace.js";
import { parseRunnerName, type RunnerName } from "../src/shared/runner";
import type { ReviewResult } from "../src/shared/schema";
import { loadFixture } from "./shared/fixture";
import { promptHash } from "./shared/prompt-hash";
import { isCompleteReport } from "./shared/report-completeness";
import { drawFindings, matchEvidence, score } from "./shared/score";
import { scorerHash } from "./shared/scorer-hash";
import {
	ANTICHEAT_VERSION,
	type Aggregates,
	type DrawResult,
	type FixtureKind,
	type FixtureSpec,
	type GateClass,
	type HoldoutMode,
	type Report,
} from "./shared/types";
import { hasConsistentCheatDetection } from "./shared/report-integrity";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const FIXTURES_REAL_DIR = path.join(__dirname, "fixtures-real");

interface RunArgs {
	runner: RunnerName;
	model: string | null;
	effort: string | null;
	provider: string | null;
	route: string | null;
	runnerVersion: string | null;
	draws: number;
	concurrency: number;
	baseline: boolean;
	report: string;
	dryRun: boolean;
	compare: string | null;
	fixtures: string | null;
	resume: string | null;
	holdout: HoldoutMode;
	gateClass: GateClass;
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
			return undefined;
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
	const provider = get("--provider");
	const route = get("--route");
	const runnerVersion = get("--runner-version");
	const provenanceFields = [provider, route, runnerVersion];
	if (
		provenanceFields.some((value) => value !== null) &&
		provenanceFields.some((value) => value === null)
	) {
		throw new Error(
			"--provider, --route, and --runner-version must be supplied together",
		);
	}
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
	const gateClassRaw = get("--gate-class") ?? "R";
	if (gateClassRaw !== "R" && gateClassRaw !== "D") {
		throw new Error(`--gate-class must be R|D, got: ${gateClassRaw}`);
	}
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
		provider,
		route,
		runnerVersion,
		draws,
		concurrency,
		baseline,
		report,
		dryRun,
		compare,
		fixtures,
		resume,
		holdout,
		gateClass: gateClassRaw as GateClass,
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
	let traceDeliveryFailed = false;
	const traceEvents: ReviewTraceEvent[] = [];
	try {
		if (dryRun) {
			error = "dry-run";
		} else {
			result = await review(
				loaded.bundle,
				{
					runner,
					model: model ?? undefined,
					reasoningEffort: effort ?? undefined,
				},
				(event: ReviewTraceEvent) => {
					traceEvents.push(event);
				},
			);
		}
	} catch (err) {
		error = err instanceof Error ? err.message : String(err);
		// runJsonPrompt rides EVERY failed attempt's raw output along on parse
		// failures — the canary scan must see them all (neither invalid output
		// nor a cleaner retry is an escape hatch).
		failedOutput = (
			err as Error & { rawOutputs?: readonly string[] }
		).rawOutputs?.join("\n");
		// Rejected reviews carry delivery health on the error (no ReviewResult).
		if (
			(err as Error & { traceDeliveryFailed?: boolean }).traceDeliveryFailed
		) {
			traceDeliveryFailed = true;
		}
	} finally {
		loaded.cleanup();
	}
	const durationMs = Date.now() - start;
	const stats = result?.stats;
	const calls = stats?.length ?? 0;
	const retries = stats?.reduce((sum, s) => sum + (s.attempts - 1), 0) ?? 0;
	const findings = result?.findings ?? [];
	return {
		fixtureId: spec.id,
		draw: 0,
		score: score(
			result,
			spec.expected,
			spec.id,
			error,
			canary,
			failedOutput,
			traceEvents,
			traceDeliveryFailed || result?.traceDeliveryFailed === true,
		),
		durationMs,
		calls,
		retries,
		findings: drawFindings(findings),
		matchEvidence: matchEvidence(findings, spec.expected),
		candidateMatchEvidence: result?.candidateFindings
			? matchEvidence(result.candidateFindings, spec.expected)
			: undefined,
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

function hasCleanCheatCount(report: Report): boolean {
	const count = report.aggregates.cheatDetectedCount as number | undefined;
	return count === 0 && hasConsistentCheatDetection(report);
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
		if (existing.scorerHash !== scorerHash()) {
			process.stderr.write(
				`resume: scorer hash mismatch (${existing.scorerHash ?? "none"} vs ${scorerHash()}), ignoring resume file\n`,
			);
			return { slots, skipped };
		}
		// Draws declared under the other gate contract satisfy different pass
		// criteria — mixing them would blend two contracts into one report.
		if ((existing.gateClass ?? "R") !== args.gateClass) {
			process.stderr.write(
				`resume: gate class mismatch (${existing.gateClass ?? "R"} vs ${args.gateClass}), ignoring resume file\n`,
			);
			return { slots, skipped };
		}
		// A fired trap voids the whole report (see cheatAlert) — none of its
		// draws may seed a fresh one. Fail closed on a MISSING count too:
		// unvalidated JSON, and absence of the canary result cannot establish
		// a clean report.
		if (!hasCleanCheatCount(existing)) {
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
		// Index good draws by their OWN recorded draw number, not by position
		// in completion order. Draws land in `existing.results` in whatever
		// order they finished (concurrent runs), and a failed draw is
		// filtered out of "good" — so a positional `good[draw]` lookup (the
		// prior approach) silently relabels one draw's result as another's:
		// e.g. draws=2 with draw 0 failed and draw 1 good leaves `good` with
		// one entry whose OWN draw number is 1, but a positional lookup would
		// hand it to slot 0 under a false draw-0 label while slot 1 (which
		// has no result at all) gets rescheduled. Reusing a draw must mean
		// "this exact draw number already has a good result on disk", never
		// "some good result exists nearby".
		//
		// `skipped` counts fully-completed fixtures (kept for the existing
		// stderr/return contract); it does not gate which individual draws
		// are reused below. A fixture interrupted partway through a run — the
		// exact scenario the per-draw checkpoint (issue #58) exists to
		// survive — still has its already-good draws on disk and must not
		// have them thrown away just because the fixture as a whole isn't
		// done.
		const goodByFixture = new Map<string, Map<number, DrawResult>>();
		for (const spec of specs) {
			const goodByDraw = new Map<number, DrawResult>();
			for (const d of byFixture.get(spec.id) ?? []) {
				if (d.score.formatOk) goodByDraw.set(d.draw, d);
			}
			goodByFixture.set(spec.id, goodByDraw);
			let complete = true;
			for (let draw = 0; draw < args.draws; draw++) {
				if (!goodByDraw.has(draw)) {
					complete = false;
					break;
				}
			}
			if (complete) skipped++;
		}
		let reusedDraws = 0;
		for (let i = 0; i < work.length; i++) {
			const { spec, draw } = work[i];
			const match = goodByFixture.get(spec.id)?.get(draw);
			if (!match) continue;
			slots[i] = {
				...match,
				draw,
				calls: match.calls ?? 0,
				retries: match.retries ?? 0,
			};
			reusedDraws++;
		}
		process.stderr.write(
			`resume: reused ${reusedDraws} draw(s) across ${skipped} fully-completed fixture(s), re-running the rest\n`,
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

// Per-process high-water mark of coverage flushed to each report path,
// tracked as the SET of (fixtureId, draw) pairs a checkpoint has written —
// not a raw count. Count is a weak proxy for "more complete": two
// checkpoints can be the same size (or the later one even larger) while the
// later one drops pairs the earlier one already covered, e.g. a
// differently-composed concurrent completion. Only the actual coverage set
// proves a checkpoint strictly retains everything already on record.
//
// This map starts empty in every process. Without seeding it from disk, a
// FRESH run (no --resume) pointed at a --report path that already holds a
// complete report from a prior invocation would have its own first partial
// checkpoint (as small as one draw) pass this guard trivially and
// atomically overwrite the old complete report. A crash before the new run
// finishes then leaves only a partial file that isCompleteReport rejects,
// with the previously-good report unrecoverably gone: the checkpoint
// feature this guard belongs to (crash resilience, #58) would have
// destroyed the very artifact it exists to protect.
const lastCheckpointCoverage = new Map<string, ReadonlySet<string>>();

function coverageKey(fixtureId: string, draw: number): string {
	return `${fixtureId} ${draw}`;
}

function coverageOf(
	results: readonly { fixtureId: string; draw: number }[],
): Set<string> {
	const pairs = new Set<string>();
	for (const r of results) pairs.add(coverageKey(r.fixtureId, r.draw));
	return pairs;
}

type ExistingReportProbe =
	| { readonly kind: "absent" }
	| { readonly kind: "coverage"; readonly pairs: ReadonlySet<string> };

// Probes whatever is already at `targetPath` (if anything) so a fresh
// process can seed its high-water mark from disk instead of starting blind.
// readFileSync follows the symlink chain to read the real file, same as any
// normal read — only rename(2)'s no-dereference-on-final-component behavior
// (handled separately by resolveWriteDestination) needs manual walking.
//
// Only a confirmed ENOENT proves nothing is there. Every other failure —
// permission denied, an I/O error, a directory in the way, content that
// isn't valid JSON, or JSON that isn't shaped like a Report — means
// something IS at that path and this call could not establish what it is.
// Treating that the same as "nothing to protect" (as an earlier version of
// this guard did) is a fail-open on a data-loss guard: silently
// unprotected instead of maximally protected. Throw instead, with an
// actionable message, so the operator hits this at the very first
// checkpoint (seconds into a run) rather than the run silently losing its
// crash-resilience guarantee for its whole duration, or a real report
// being silently destroyed at the very end.
function probeExistingReport(targetPath: string): ExistingReportProbe {
	let raw: string;
	try {
		raw = readFileSync(targetPath, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "absent" };
		}
		throw new Error(
			`--report target ${targetPath} exists but could not be read (${
				(error as NodeJS.ErrnoException).code ?? String(error)
			}). Refusing to checkpoint over it without knowing what it contains — ` +
				"move or delete the file, fix its permissions, or point --report elsewhere, then retry.",
			{ cause: error },
		);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(
			`--report target ${targetPath} exists but is not valid JSON. Refusing to ` +
				"checkpoint over it without knowing what it contains — move or delete the file, or point --report elsewhere, then retry.",
			{ cause: error },
		);
	}
	const existingResults = (parsed as { results?: unknown }).results;
	if (!Array.isArray(existingResults)) {
		throw new Error(
			`--report target ${targetPath} exists but does not look like a Report (no results array). ` +
				"Refusing to checkpoint over it without knowing what it contains — move or delete the file, or point --report elsewhere, then retry.",
		);
	}
	return {
		kind: "coverage",
		pairs: coverageOf(existingResults as { fixtureId: string; draw: number }[]),
	};
}

// Symlink chains can be arbitrarily long; this is comfortably above what any
// real --report path would use and matches the ballpark of the OS's own
// ELOOP threshold (Linux: 40). It exists to fail closed on a cycle rather
// than hang, not to be a realistic chain length.
const MAX_SYMLINK_CHAIN = 40;

// rename(2) does not dereference a symlink in its final path component:
// renaming a temp file onto a symlinked target would unlink the symlink
// itself (or, mid-chain, an intermediate link) and install a plain file in
// its place, silently destroying the alias. Walk the chain by hand — one
// lstat+readlink hop at a time — rather than leaning on realpathSync, so a
// live chain, a chain broken at its final hop (dangling), and no symlink at
// all are all resolved by the same logic to the same real write
// destination. A dangling final hop resolves to the path it points at
// (which this write will then create) instead of stopping at the last
// intermediate link.
function resolveWriteDestination(targetPath: string): string {
	let current = targetPath;
	for (let hops = 0; hops < MAX_SYMLINK_CHAIN; hops++) {
		let stat;
		try {
			stat = lstatSync(current);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				throw error;
			}
			// Nothing at `current`: either targetPath never existed, or we
			// walked a chain of symlinks to a dangling final link. Either
			// way, this is the real write destination.
			return current;
		}
		if (!stat.isSymbolicLink()) {
			return current;
		}
		current = path.resolve(path.dirname(current), readlinkSync(current));
	}
	throw new Error(
		`symlink chain too deep resolving --report target: ${targetPath}`,
	);
}

function atomicWriteFile(targetPath: string, contents: string): void {
	const resolvedTarget = resolveWriteDestination(targetPath);
	const directory = path.dirname(resolvedTarget);
	mkdirSync(directory, { recursive: true });
	const tempPath = path.join(
		directory,
		`.${path.basename(resolvedTarget)}.${randomUUID()}.tmp`,
	);
	try {
		writeFileSync(tempPath, contents);
		renameSync(tempPath, resolvedTarget);
	} finally {
		try {
			unlinkSync(tempPath);
		} catch {
			// rename consumes the temp path; a failed create never produced one.
		}
	}
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
		meanNoisePerPositive,
		cheatDetectedCount,
		baitExposureCount,
		criticPrunedRecallCount,
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
		...(args.provider !== null &&
		args.route !== null &&
		args.runnerVersion !== null
			? {
					provider: args.provider,
					route: args.route,
					runnerVersion: args.runnerVersion,
				}
			: {}),
		draws: args.draws,
		createdAt: new Date().toISOString(),
		baseline: args.baseline,
		holdout: args.holdout,
		gateClass: args.gateClass,
		results,
		aggregates: aggregate(results, specs),
		gitSha: repoGitSha(),
		fixtureSetHash: fixtureSetHash(specs),
		scorerHash: scorerHash(),
		fixtureTiers,
		// The version label is a promise that every current-generation guard was on:
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
	const targetPath = path.resolve(args.report);
	if (!lastCheckpointCoverage.has(targetPath)) {
		// First checkpoint attempt this process has made to this path: seed
		// the high-water mark from whatever report is already on disk (this
		// throws if something is there and unreadable — see
		// probeExistingReport) so this run's own first (necessarily small)
		// partial checkpoint cannot silently destroy a prior report before
		// this run has produced anything at least as complete.
		const probe = probeExistingReport(targetPath);
		lastCheckpointCoverage.set(
			targetPath,
			probe.kind === "coverage" ? probe.pairs : new Set(),
		);
	}
	const lastCoverage = lastCheckpointCoverage.get(targetPath) as ReadonlySet<string>;
	const incomingCoverage = coverageOf(results);
	// A partial (still in-progress) checkpoint must never drop any pair
	// already covered at this path — from a prior process's on-disk report
	// or from this run's own earlier checkpoints. Comparing sets (not
	// counts) catches the case count-comparison misses: an equal- or
	// larger-sized checkpoint that is differently composed and silently
	// drops a pair the prior checkpoint had. But a report that is itself
	// structurally complete (every fixture x draw pair present) is this
	// run's deliberate final artifact and always wins, even over pairs it
	// does not itself retain (e.g. a rerun with --draws intentionally
	// lowered, or a different fixture set) — otherwise --report would
	// become unusable for a legitimate rerun.
	const incomingComplete = isCompleteReport(
		report,
		specs.map((s) => s.id),
	);
	const retainsAllPriorCoverage = [...lastCoverage].every((key) =>
		incomingCoverage.has(key),
	);
	if (!incomingComplete && !retainsAllPriorCoverage) {
		return report;
	}
	atomicWriteFile(targetPath, JSON.stringify(report, null, 2));
	const merged = new Set(lastCoverage);
	for (const key of incomingCoverage) merged.add(key);
	lastCheckpointCoverage.set(targetPath, merged);
	return report;
}

export function compare(baselinePath: string, candidate: Report): void {
	let baseline: Report;
	try {
		baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as Report;
	} catch (error) {
		throw new Error(`failed to parse baseline report ${baselinePath}`, {
			cause: error,
		});
	}
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
	// R and D reports satisfy different pass contracts (full-contract recall vs
	// reduced delivery criteria). A delta across classes would present numbers
	// earned under different rules as one measurement. Legacy reports predate
	// the field and compare as R.
	const baselineGate = baseline.gateClass ?? "R";
	const candidateGate = candidate.gateClass ?? "R";
	if (baselineGate !== candidateGate) {
		throw new Error(
			`gate class mismatch: baseline is ${baselineGate}, candidate is ${candidateGate}. Compare against a baseline run under the same contract.`,
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
		if (report.scorerHash !== scorerHash()) {
			throw new Error(
				`${label} report scorer hash is ${report.scorerHash ?? "none"}, current is ${scorerHash()}. Re-run the ${label} under the current scorer.`,
			);
		}
		// A fired trap voids the whole report (see cheatAlert) — void numbers
		// cannot anchor or pass a comparison. A MISSING count fails closed too:
		// unvalidated JSON, and absence of the canary result cannot establish
		// a clean report.
		if (!hasCleanCheatCount(report)) {
			throw new Error(
				`${label} report is compromised or unverifiable (cheatDetectedCount=${report.aggregates.cheatDetectedCount ?? "missing"}). Investigate the runner sandbox and re-run the ${label}.`,
			);
		}
		// Partial resume snapshots still earn anticheatVersion; comparing them
		// would print biased fixture×draw coverage as if full-set.
		if (!isCompleteReport(report)) {
			throw new Error(
				`${label} report is incomplete (fixture × draw coverage). Re-run the full ${label} set before comparing.`,
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

// Any anti-cheat detection (repository bait canary and/or honeypot trap)
// voids the report. Wording is detector-neutral: G3 bait hits are not
// honeypot-only, and operators must not be steered to the wrong root cause.
export function cheatAlert(report: Report): void {
	process.stderr.write(
		`\nBAIT EXPOSURE: ${report.aggregates.baitExposureCount} draw(s) exposed planted bait on raw transcript surfaces; no structured use was detected.\n\n`,
	);
	if (report.aggregates.cheatDetectedCount > 0) {
		process.stderr.write(
			`\nCHEAT ALERT: anti-cheat detection fired in ${report.aggregates.cheatDetectedCount} draw(s). ` +
				`The runner referenced planted bait (repository answer-key canary and/or honeypot trap content). ` +
				`Treat every number in this report as compromised and investigate the runner sandbox.\n\n`,
		);
		// A compromised report must also fail the command: the report stays on
		// disk for diagnosis, but no caller (CI gate, compare, scripts) may see
		// this run exit 0.
		process.exitCode = 1;
	}
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
		// Only Class R full-contract reports may anchor future comparisons; a
		// D report's reduced criteria would silently become the bar every
		// later candidate is judged by.
		if (args.baseline && args.gateClass !== "R") {
			throw new Error(
				"--baseline requires --gate-class R: only full-contract runs may anchor comparisons",
			);
		}
		const loaded = await loadFixtures(args.fixtures);
		const specs = filterByHoldout(loaded, args.holdout);
		const work = buildWorkList(specs, args.draws);
		// Per-run canary (G3): a unique token embedded in the bait answer key.
		// Threaded through fixture materialization and scoring; a finding that
		// contains it means the runner copied the planted answer key.
		const canary = randomUUID();
		// Checkpoint after every completed draw. --resume only controls whether
		// we LOAD a compatible prior report; a crash of a fresh run must still
		// leave a structurally valid partial file at args.report.
		const checkpoint = (partial: readonly DrawResult[]): void => {
			writeReport(args, partial, specs);
		};

		if (args.compare) {
			const slots: (DrawResult | null)[] = new Array(work.length).fill(null);
			const results = await runWork(args, work, slots, canary, checkpoint);
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
		const results = await runWork(args, work, slots, canary, checkpoint);

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
