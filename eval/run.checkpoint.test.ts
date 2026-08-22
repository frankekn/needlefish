import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
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

	writeReport(parseArgs(["--draws", "1", "--report", reportPath]), [drawA], specs);

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
const args = parseArgs(["--draws", "1", "--report", reportPath, "--resume", reportPath]);
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
	t.after(() => {
		if (child.exitCode === null && child.signalCode === null) {
			child.kill("SIGKILL");
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
	child.kill("SIGKILL");
	await waitForExit(child, 10_000);

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
