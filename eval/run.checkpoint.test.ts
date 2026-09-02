import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	fixtureSetHash,
	mapLimit,
	parseArgs,
	resumeSlots,
	writeReport,
} from "./run";
import { isCompleteReport } from "./shared/report-completeness";
import { score } from "./shared/score";
import type { DrawResult, FixtureSpec, Report } from "./shared/types";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RUNNER_ATTESTATION_ARGS = [
	"--model",
	"test-model",
	"--effort",
	"medium",
	"--provider",
	"Test provider",
	"--route",
	"Test route",
	"--runner-version",
	"test-runner 1",
] as const;

function checkpointSpec(id: string): FixtureSpec {
	return {
		id,
		kind: "positive",
		defectClass: "test",
		description: "test",
		baseFiles: {},
		headFiles: {},
		expected: { verdict: "pass", mustFind: [{ pattern: "x" }] },
	};
}

function makeDraw(spec: FixtureSpec, draw: number): DrawResult {
	return {
		fixtureId: spec.id,
		draw,
		score: score({ verdict: "pass", findings: [] }, spec.expected, spec.id),
		durationMs: 1,
		calls: 1,
		retries: 0,
	};
}

function readReport(reportPath: string): Report {
	const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
	assert.equal(typeof parsed, "object");
	assert.notEqual(parsed, null);
	return parsed as Report;
}

function leftoverTemps(dir: string): string[] {
	return readdirSync(dir).filter((name) => name.includes(".tmp"));
}

function withGuardEnv(t: { after: (fn: () => void) => void }): void {
	const previous = {
		home: process.env.NEEDLEFISH_EPHEMERAL_HOME,
		trace: process.env.NEEDLEFISH_EVAL_TRACE,
	};
	process.env.NEEDLEFISH_EPHEMERAL_HOME = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";
	t.after(() => {
		if (previous.home === undefined) delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
		else process.env.NEEDLEFISH_EPHEMERAL_HOME = previous.home;
		if (previous.trace === undefined) delete process.env.NEEDLEFISH_EVAL_TRACE;
		else process.env.NEEDLEFISH_EVAL_TRACE = previous.trace;
	});
}

test("writeReport: a fresh run without --resume still writes a structurally valid partial report", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-fresh-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const specA = checkpointSpec("checkpoint-fresh-a");
	const specB = checkpointSpec("checkpoint-fresh-b");
	const args = parseArgs(["--draws", "1", "--report", reportPath]);
	assert.equal(args.resume, null);

	writeReport(args, [makeDraw(specA, 0)], [specA, specB]);

	const onDisk = readReport(reportPath);
	assert.equal(onDisk.results.length, 1);
	assert.equal(onDisk.results[0]?.fixtureId, specA.id);
	assert.deepEqual(onDisk.fixtures, [specA.id, specB.id]);
	assert.equal(onDisk.promptHash.length > 0, true);
	assert.equal(onDisk.fixtureSetHash, fixtureSetHash([specA, specB]));
	assert.equal(typeof onDisk.scorerHash, "string");
	const fixtureKinds = (onDisk as { fixtureKinds?: Readonly<Record<string, string>> })
		.fixtureKinds;
	assert.equal(fixtureKinds?.[specA.id], "positive");
	assert.equal(fixtureKinds?.[specB.id], "positive");
	assert.equal(typeof onDisk.aggregates, "object");
	assert.equal(isCompleteReport(onDisk), false);
	assert.deepEqual(leftoverTemps(dir), []);
});

// Atomic replacement is the rename(2) of a same-directory temp over the
// target; this test only checks that the temp is not left behind. A plain
// writeFileSync to the target would also pass the leftover check.
test("writeReport: leaves no temp files behind", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-atomic-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const spec = checkpointSpec("checkpoint-atomic");
	const args = parseArgs(["--draws", "2", "--report", reportPath]);

	writeReport(args, [makeDraw(spec, 0)], [spec]);
	writeReport(args, [makeDraw(spec, 0), makeDraw(spec, 1)], [spec]);

	const onDisk = readReport(reportPath);
	assert.equal(onDisk.results.length, 2);
	assert.equal(isCompleteReport(onDisk), true);
	assert.deepEqual(leftoverTemps(dir), []);
});

test("writeReport: a later smaller checkpoint does not overwrite a larger one", async (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-monotonic-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const spec = checkpointSpec("checkpoint-monotonic");
	const args = parseArgs(["--draws", "4", "--report", reportPath]);
	const draws = [0, 1, 2, 3].map((draw) => makeDraw(spec, draw));

	await mapLimit([4, 3, 2, 1], 4, async (count) => {
		await Promise.resolve();
		writeReport(args, draws.slice(0, count), [spec]);
	});

	const onDisk = readReport(reportPath);
	assert.equal(onDisk.results.length, 4);
	assert.deepEqual(
		onDisk.results.map((result) => result.draw),
		[0, 1, 2, 3],
	);
	assert.deepEqual(leftoverTemps(dir), []);
});

// lastCheckpointCounts is a process-local high-water mark, empty at process
// start. Without seeding it from whatever is already on disk, a FRESH run
// (no --resume) that reuses a --report path already holding a complete
// report from a prior process would have its own first partial checkpoint
// (as small as one draw) pass the guard trivially and destroy that report —
// and a crash before the new run finishes would leave only a partial file
// behind, with the previously-good report unrecoverably gone. This
// simulates the prior process by writing the "existing" complete report via
// copyFileSync (not writeReport), so this test's own lastCheckpointCounts
// has no entry for reportPath when the "fresh run" begins.
test("writeReport: a fresh run's interrupted partial checkpoint does not destroy a complete report already on disk", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(
		path.join(tmpdir(), "needlefish-checkpoint-preserve-existing-"),
	);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const stagingPath = path.join(dir, "staging.json");

	// A prior process's complete report: 2 fixtures x 2 draws = 4 results.
	const specA = checkpointSpec("checkpoint-preserve-existing-a");
	const specB = checkpointSpec("checkpoint-preserve-existing-b");
	const priorSpecs = [specA, specB];
	const priorResults = [
		makeDraw(specA, 0),
		makeDraw(specA, 1),
		makeDraw(specB, 0),
		makeDraw(specB, 1),
	];
	const priorArgs = parseArgs(["--draws", "2", "--report", stagingPath]);
	const priorReport = writeReport(priorArgs, priorResults, priorSpecs);
	assert.equal(isCompleteReport(priorReport, priorSpecs.map((s) => s.id)), true);
	copyFileSync(stagingPath, reportPath);

	// A fresh, unrelated, non-resumed run targets the same --report path
	// with a smaller, different fixture set. Only its first draw completes
	// before the process is "interrupted" (simulated by simply not issuing
	// any further writeReport call).
	const specC = checkpointSpec("checkpoint-preserve-existing-c");
	const freshSpecs = [specC];
	const freshArgs = parseArgs(["--draws", "2", "--report", reportPath]);
	writeReport(freshArgs, [makeDraw(specC, 0)], freshSpecs);

	const afterPartial = readReport(reportPath);
	assert.equal(
		afterPartial.results.length,
		4,
		"an interrupted fresh run's partial checkpoint must not destroy the complete report already on disk",
	);
	assert.equal(isCompleteReport(afterPartial, priorSpecs.map((s) => s.id)), true);

	// The fresh run continues and reaches its OWN completion (2 draws for
	// its 1 fixture = 2 results) — smaller than the old report's 4, but
	// structurally complete on its own terms. A legitimate finished rerun
	// must still be able to replace an old complete report; the guard must
	// not make --report unusable for an intentional smaller rerun.
	const finalReport = writeReport(
		freshArgs,
		[makeDraw(specC, 0), makeDraw(specC, 1)],
		freshSpecs,
	);
	assert.equal(isCompleteReport(finalReport, freshSpecs.map((s) => s.id)), true);
	const afterFinal = readReport(reportPath);
	assert.equal(
		afterFinal.results.length,
		2,
		"a legitimately completed fresh run must still be able to replace an old complete report",
	);
	assert.deepEqual(
		afterFinal.results.map((r) => r.fixtureId),
		[specC.id, specC.id],
	);
});

// Raw result count is a weak proxy for "more complete": a same-sized (or
// even larger) checkpoint can be differently composed and silently drop a
// fixture x draw pair the prior checkpoint already covered. The guard must
// compare actual coverage, not cardinality.
test("writeReport: an equal-count but worse-coverage checkpoint does not overwrite", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(
		path.join(tmpdir(), "needlefish-checkpoint-coverage-"),
	);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const specA = checkpointSpec("checkpoint-coverage-a");
	const specB = checkpointSpec("checkpoint-coverage-b");
	const specs = [specA, specB];
	const args = parseArgs(["--draws", "2", "--report", reportPath]);

	// First checkpoint: draw 0 for both fixtures (2 results), covering
	// {A:0, B:0}.
	writeReport(args, [makeDraw(specA, 0), makeDraw(specB, 0)], specs);
	assert.equal(readReport(reportPath).results.length, 2);

	// A same-sized checkpoint that is differently composed: {A:0, A:1} is
	// still 2 results (equal count, so a pure count check would let it
	// through) but drops B:0's coverage in favor of A:1. It must be
	// blocked because it does not retain everything the prior checkpoint
	// already covered.
	writeReport(args, [makeDraw(specA, 0), makeDraw(specA, 1)], specs);

	const onDisk = readReport(reportPath);
	assert.deepEqual(
		onDisk.results.map((r) => `${r.fixtureId}:${r.draw}`).sort(),
		["checkpoint-coverage-a:0", "checkpoint-coverage-b:0"],
		"an equal-count checkpoint that drops previously-covered pairs must not overwrite",
	);
});

// Only a confirmed ENOENT proves nothing is at --report. Any other read
// failure (garbage content that isn't valid JSON, here — a real failure
// exercised through the actual JSON.parse path, not a mocked throw) means
// something IS there and must be treated as maximally protected: fail
// closed with an actionable error rather than silently treating it as
// absent and overwriting it.
test("writeReport: an unreadable existing report at --report is never treated as absent", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(
		path.join(tmpdir(), "needlefish-checkpoint-unreadable-"),
	);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const garbage = "{ this is not valid json";
	writeFileSync(reportPath, garbage);
	const spec = checkpointSpec("checkpoint-unreadable");
	const args = parseArgs(["--draws", "2", "--report", reportPath]);

	assert.throws(
		() => writeReport(args, [makeDraw(spec, 0)], [spec]),
		/not valid JSON/,
		"an existing file that can't be parsed as a report must fail closed, not be treated as absent",
	);

	assert.equal(
		readFileSync(reportPath, "utf8"),
		garbage,
		"a fail-closed refusal must leave the unreadable file untouched",
	);
	assert.deepEqual(leftoverTemps(dir), []);
});

test("writeReport: the completed report atomically supersedes a partial checkpoint", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-final-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const specA = checkpointSpec("checkpoint-final-a");
	const specB = checkpointSpec("checkpoint-final-b");
	const args = parseArgs(["--draws", "1", "--report", reportPath]);
	const drawA = makeDraw(specA, 0);
	const drawB = makeDraw(specB, 0);

	writeReport(args, [drawA], [specA, specB]);
	assert.equal(isCompleteReport(readReport(reportPath)), false);

	writeReport(args, [drawA, drawB], [specA, specB]);
	const onDisk = readReport(reportPath);
	assert.equal(onDisk.results.length, 2);
	assert.equal(isCompleteReport(onDisk), true);
	assert.deepEqual(leftoverTemps(dir), []);
});

test("writeReport: a failed replace does not leave a temp file", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-fail-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	mkdirSync(reportPath);
	const spec = checkpointSpec("checkpoint-fail");
	const args = parseArgs(["--draws", "1", "--report", reportPath]);

	assert.throws(() => writeReport(args, [makeDraw(spec, 0)], [spec]));
	assert.deepEqual(leftoverTemps(dir), []);
});

// rename(2) does not dereference a symlink in its final path component:
// a naive rename(tempPath, targetPath) over a symlinked --report path would
// unlink the symlink and install a plain file, silently destroying the
// alias. writeReport must instead write through to the symlink's resolved
// destination and leave the symlink itself in place.
test("writeReport: a symlinked --report target stays a symlink and is written through", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-symlink-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const realPath = path.join(dir, "real-report.json");
	const linkPath = path.join(dir, "report.json");
	// Valid-but-empty report JSON, not arbitrary garbage: this file only
	// needs to make the symlink non-dangling for this test's purpose (the
	// symlink surviving a write-through); real garbage content is its own,
	// separately-tested case (see "an unreadable existing report...").
	writeFileSync(realPath, JSON.stringify({ results: [] }));
	symlinkSync(realPath, linkPath);
	const spec = checkpointSpec("checkpoint-symlink");
	const args = parseArgs(["--draws", "1", "--report", linkPath]);

	writeReport(args, [makeDraw(spec, 0)], [spec]);

	assert.equal(
		lstatSync(linkPath).isSymbolicLink(),
		true,
		"the --report path must remain a symlink after checkpointing",
	);
	assert.equal(readlinkSync(linkPath), realPath);
	const onDiskViaLink = readReport(linkPath);
	assert.equal(onDiskViaLink.results.length, 1);
	assert.equal(onDiskViaLink.results[0]?.fixtureId, spec.id);
	const onDiskViaReal = readReport(realPath);
	assert.equal(onDiskViaReal.results.length, 1);
	assert.deepEqual(leftoverTemps(dir), []);
});

// A dangling symlink (pointing at a path that doesn't exist yet) must still
// resolve: realpathSync fails for a dangling link, so the fallback has to
// resolve the link's own text relative to its directory instead of
// replacing the link with a plain file.
test("writeReport: a dangling symlinked --report target is written through and stays a symlink", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-dangling-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const realPath = path.join(dir, "not-yet-created.json");
	const linkPath = path.join(dir, "report.json");
	symlinkSync(realPath, linkPath);
	const spec = checkpointSpec("checkpoint-dangling");
	const args = parseArgs(["--draws", "1", "--report", linkPath]);

	writeReport(args, [makeDraw(spec, 0)], [spec]);

	assert.equal(
		lstatSync(linkPath).isSymbolicLink(),
		true,
		"the --report path must remain a symlink after checkpointing",
	);
	assert.equal(readlinkSync(linkPath), realPath);
	assert.equal(existsSync(realPath), true);
	const onDiskViaLink = readReport(linkPath);
	assert.equal(onDiskViaLink.results.length, 1);
	assert.deepEqual(leftoverTemps(dir), []);
});

// A single hop of a dangling chain is not enough: rename(2) would still
// unlink an *intermediate* symlink (link -> mid -> real, where real doesn't
// exist yet) and replace it with a plain file, leaving `link` broken. The
// whole chain must be walked to the final (possibly nonexistent) target.
test("writeReport: a multi-hop dangling symlink chain is written through and every link survives", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-chain-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const realPath = path.join(dir, "not-yet-created.json");
	const midPath = path.join(dir, "mid-link.json");
	const linkPath = path.join(dir, "report.json");
	symlinkSync(realPath, midPath);
	symlinkSync(midPath, linkPath);
	const spec = checkpointSpec("checkpoint-chain");
	const args = parseArgs(["--draws", "1", "--report", linkPath]);

	writeReport(args, [makeDraw(spec, 0)], [spec]);

	assert.equal(
		lstatSync(linkPath).isSymbolicLink(),
		true,
		"the outer --report symlink must survive",
	);
	assert.equal(readlinkSync(linkPath), midPath);
	assert.equal(
		lstatSync(midPath).isSymbolicLink(),
		true,
		"the intermediate symlink must survive, not be replaced by the report file",
	);
	assert.equal(readlinkSync(midPath), realPath);
	assert.equal(existsSync(realPath), true, "the chain's final target must be created");
	const onDiskViaLink = readReport(linkPath);
	assert.equal(onDiskViaLink.results.length, 1);
	assert.deepEqual(leftoverTemps(dir), []);
});

// resumeSlots gated ALL of a fixture's slot reuse on the fixture having
// args.draws good results. A fixture interrupted partway through (the exact
// case the per-draw checkpoint exists to survive) would have its
// already-good draws discarded and rerun from scratch on --resume,
// defeating the checkpoint's purpose at fixture granularity.
test("resumeSlots: reuses already-checkpointed draws from a partially-completed fixture", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(
		path.join(tmpdir(), "needlefish-checkpoint-partial-resume-"),
	);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const spec = checkpointSpec("checkpoint-partial-resume");
	const specs = [spec];
	const writeArgs = parseArgs([
		"--draws", "2", "--report", reportPath, ...RUNNER_ATTESTATION_ARGS,
	]);
	// Only draw 0 completed before the process was interrupted; draw 1 never ran.
	writeReport(writeArgs, [makeDraw(spec, 0)], specs);

	const resumeArgs = parseArgs([
		"--draws",
		"2",
		"--report",
		reportPath,
		"--resume",
		reportPath,
		...RUNNER_ATTESTATION_ARGS,
	]);
	const work = [
		{ spec, draw: 0 },
		{ spec, draw: 1 },
	];
	const resumed = resumeSlots(resumeArgs, specs, work);

	assert.equal(
		resumed.skipped,
		0,
		"the fixture is not fully complete and must not count as skipped",
	);
	assert.notEqual(
		resumed.slots[0],
		null,
		"the already-checkpointed draw 0 must be reused, not rerun",
	);
	assert.equal(resumed.slots[0]?.draw, 0);
	assert.equal(
		resumed.slots[1],
		null,
		"draw 1 was never completed and must still be scheduled",
	);
});

// A positional `good[draw]` lookup relabels results: if draw 0 failed
// format and draw 1 succeeded, the one entry in `good` (draw 1's own
// result) sits at position 0 and would be mislabeled as draw 0, backfilling
// the failed draw with a stranger's result while the untouched draw 1 slot
// gets needlessly rescheduled. Reuse must be keyed by each draw's own
// recorded draw number.
test("resumeSlots: reuses a draw only under its own recorded draw number, never a stranger's", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(
		path.join(tmpdir(), "needlefish-checkpoint-draw-index-"),
	);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const spec = checkpointSpec("checkpoint-draw-index");
	const specs = [spec];
	const writeArgs = parseArgs([
		"--draws", "2", "--report", reportPath, ...RUNNER_ATTESTATION_ARGS,
	]);
	const failedDraw0 = makeDraw(spec, 0);
	const goodDraw1 = makeDraw(spec, 1);
	const invalidDraw0 = {
		...failedDraw0,
		score: { ...failedDraw0.score, formatOk: false },
	};
	writeReport(writeArgs, [invalidDraw0, goodDraw1], specs);

	const resumeArgs = parseArgs([
		"--draws",
		"2",
		"--report",
		reportPath,
		"--resume",
		reportPath,
		...RUNNER_ATTESTATION_ARGS,
	]);
	const work = [
		{ spec, draw: 0 },
		{ spec, draw: 1 },
	];
	const resumed = resumeSlots(resumeArgs, specs, work);

	assert.equal(
		resumed.slots[0],
		null,
		"draw 0's own result was invalid and must be rerun under its own index, not backfilled from draw 1",
	);
	assert.notEqual(
		resumed.slots[1],
		null,
		"draw 1's own good result must be reused under its own index",
	);
	assert.equal(resumed.slots[1]?.draw, 1);

	// Gate-integrity check: a resumed run must not understate the invalid
	// rate versus an uninterrupted run of the exact same two attempts. A
	// non-resumed run of [invalid draw 0, good draw 1] would report
	// invalidJsonRate 0.5; if resume silently drops the invalid draw (by
	// mislabeling a good draw over it and never truly retrying slot 0), the
	// gate would see a better number than reality.
	const baselineReport = writeReport(
		parseArgs(["--draws", "2", "--report", path.join(dir, "baseline.json")]),
		[invalidDraw0, goodDraw1],
		specs,
	);
	assert.equal(baselineReport.aggregates.invalidJsonRate, 0.5);

	// The resumed process retries slot 0 (the invalid draw) and, in this
	// scenario, reproduces the same failure again.
	const rerunDraw0 = {
		...makeDraw(spec, 0),
		score: { ...makeDraw(spec, 0).score, formatOk: false },
	};
	const finalResults = [rerunDraw0, resumed.slots[1]!];
	const finalReport = writeReport(resumeArgs, finalResults, specs);

	assert.equal(
		finalReport.results.length,
		2,
		"every draw must be accounted for in the final report",
	);
	assert.equal(
		finalReport.aggregates.invalidJsonRate,
		baselineReport.aggregates.invalidJsonRate,
		"resume must not understate the invalid-draw rate relative to an uninterrupted run",
	);
});

test("checkpoint: an interrupted fresh run leaves a partial report a later process --resume continues", (t) => {
	withGuardEnv(t);
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-resume-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const specA = checkpointSpec("checkpoint-resume-a");
	const specB = checkpointSpec("checkpoint-resume-b");
	const drawA = makeDraw(specA, 0);
	const drawB = makeDraw(specB, 0);
	const specs = [specA, specB];

	writeReport(
		parseArgs(["--draws", "1", "--report", reportPath, ...RUNNER_ATTESTATION_ARGS]),
		[drawA],
		specs,
	);

	const withoutResume = resumeSlots(
		parseArgs(["--draws", "1", "--report", reportPath]),
		specs,
		specs.map((spec) => ({ spec, draw: 0 })),
	);
	assert.equal(withoutResume.skipped, 0, "--resume remains the opt-in for loading");
	assert.deepEqual(withoutResume.slots, [null, null]);

	const childPath = path.join(dir, "continue.ts");
	writeFileSync(
		childPath,
		`import { parseArgs, resumeSlots, writeReport } from ${JSON.stringify(pathToFileURL(path.join(__dirname, "run.ts")).href)};

const specs = ${JSON.stringify(specs)};
const draws = ${JSON.stringify([drawA, drawB])};
const reportPath = ${JSON.stringify(reportPath)};
const args = parseArgs(["--draws", "1", "--report", reportPath, "--resume", reportPath, ${JSON.stringify([...RUNNER_ATTESTATION_ARGS])}].flat());
const work = specs.map((spec) => ({ spec, draw: 0 }));
const resumed = resumeSlots(args, specs, work);
if (resumed.skipped !== 1) {
	throw new Error("expected 1 skipped fixture, got " + resumed.skipped);
}
if (resumed.slots[0] === null || resumed.slots[1] !== null) {
	throw new Error("expected the completed fixture reused and the rest pending");
}
writeReport(args, draws, specs);
process.stdout.write(JSON.stringify({ skipped: resumed.skipped }) + "\\n");
`,
	);

	const child = spawnSync(process.execPath, ["--import", "tsx", childPath], {
		encoding: "utf8",
		timeout: 60_000,
		env: {
			...process.env,
			NEEDLEFISH_EPHEMERAL_HOME: "1",
			NEEDLEFISH_EVAL_TRACE: "1",
		},
	});
	assert.equal(
		child.status,
		0,
		`fresh-process resume must succeed, stderr: ${child.stderr}`,
	);
	const childOut: unknown = JSON.parse(child.stdout.trim());
	assert.equal(typeof childOut, "object");
	assert.equal((childOut as { skipped: number }).skipped, 1);

	const onDisk = readReport(reportPath);
	assert.equal(onDisk.results.length, 2);
	assert.deepEqual(
		onDisk.results.map((result) => result.fixtureId),
		[specA.id, specB.id],
	);
	assert.equal(isCompleteReport(onDisk), true);
	assert.deepEqual(leftoverTemps(dir), []);
});

function collectOutput(child: ChildProcess): { stdout: string; stderr: string } {
	const output = { stdout: "", stderr: "" };
	child.stdout?.setEncoding("utf8");
	child.stderr?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => {
		output.stdout += chunk;
	});
	child.stderr?.on("data", (chunk: string) => {
		output.stderr += chunk;
	});
	return output;
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		if (child.exitCode !== null || child.signalCode !== null) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			reject(new Error("eval child did not exit after SIGKILL"));
		}, timeoutMs);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
	});
}

function killChildTree(child: ChildProcess): void {
	if (child.pid === undefined) return;
	if (process.platform === "win32") {
		child.kill("SIGKILL");
		return;
	}
	try {
		process.kill(-child.pid, "SIGKILL");
	} catch (error) {
		if (!isMissingProcess(error)) throw error;
	}
}

async function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<void> {
	if (process.platform === "win32") return;
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			process.kill(-pid, 0);
		} catch (error) {
			if (isMissingProcess(error)) return;
			throw error;
		}
		await delay(10);
	}
	throw new Error("eval child process group did not exit after SIGKILL");
}

function isMissingProcess(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "ESRCH";
}

// Drives eval/run.ts main(), not writeReport: a fresh weekly-shaped run
// (no --resume) must checkpoint after each draw. Gating that callback on
// args.resume is the issue #58 bug and must fail this test.
test("eval CLI: an interrupted dry-run without --resume leaves a partial report", async (t) => {
	const dir = mkdtempSync(path.join(tmpdir(), "needlefish-checkpoint-cli-"));
	const childTmp = path.join(dir, "tmp");
	mkdirSync(childTmp);
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const reportPath = path.join(dir, "report.json");
	const draws = 20;
	const child = spawn(
		process.execPath,
		[
			"--import",
			"tsx",
			path.resolve(__dirname, "run.ts"),
			"--dry-run",
			"--runner",
			"codex",
			"--draws",
			String(draws),
			"--concurrency",
			"1",
			"--fixtures",
			"^neg-style-only$",
			"--report",
			reportPath,
		],
		{
			cwd: path.resolve(__dirname, ".."),
			detached: process.platform !== "win32",
			env: {
				...process.env,
				TMPDIR: childTmp,
				TMP: childTmp,
				NEEDLEFISH_EPHEMERAL_HOME: "1",
				NEEDLEFISH_EVAL_TRACE: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	const output = collectOutput(child);
	t.after(async () => {
		if (child.exitCode === null && child.signalCode === null) {
			killChildTree(child);
			await waitForExit(child, 10_000);
			if (child.pid !== undefined) await waitForProcessGroupExit(child.pid, 10_000);
		}
	});

	const deadline = Date.now() + 30_000;
	while (!existsSync(reportPath) && Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			break;
		}
		await delay(15);
	}

	assert.equal(
		existsSync(reportPath),
		true,
		`fresh run must checkpoint before exit; status=${child.exitCode} signal=${child.signalCode} stderr=${output.stderr}`,
	);
	assert.equal(
		child.exitCode,
		null,
		`report appeared only after the process finished (final write, not a per-draw checkpoint); stderr=${output.stderr}`,
	);
	killChildTree(child);
	await waitForExit(child, 10_000);
	if (child.pid !== undefined) await waitForProcessGroupExit(child.pid, 10_000);

	const onDisk = readReport(reportPath);
	assert.ok(
		onDisk.results.length >= 1,
		"interrupted run must have completed at least one draw",
	);
	assert.ok(
		onDisk.results.length < draws,
		`expected a partial checkpoint, got ${onDisk.results.length}/${draws} draws (final write, not per-draw)`,
	);
	assert.equal(onDisk.draws, draws);
	assert.deepEqual(onDisk.fixtures, ["neg-style-only"]);
	assert.equal(typeof onDisk.promptHash, "string");
	assert.equal(onDisk.promptHash.length > 0, true);
	assert.equal(typeof onDisk.fixtureSetHash, "string");
	assert.equal(typeof onDisk.aggregates, "object");
	assert.equal(isCompleteReport(onDisk), false);
});
