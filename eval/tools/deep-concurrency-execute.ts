import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { cpus, loadavg, platform, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { review, type ReviewProgressEvent } from "../../src/core/review";
import { isNativeExecutable } from "../../src/shared/codex-invocation";
import { runManagedRunnerProcess, type ManagedRunnerProcessController } from "../../src/shared/runner-process";
import { registerTerminationFinalizer } from "../../src/shared/temp-lifecycle";
import type { ReviewTraceEvent } from "../../src/core/review-trace";
import { changedFilesFromPaths, makeBundle } from "../../src/shared/repo";
import type { Bundle, ReviewResult } from "../../src/shared/schema";
import positive from "../fixtures/large-tail-boundary-bug/spec";
import negative from "../fixtures/large-clean-sweep/spec";
import { loadFixture } from "../shared/fixture";
import { fixtureSetHash } from "../shared/fixture-catalog";
import { promptHash } from "../shared/prompt-hash";
import { score } from "../shared/score";
import { assertDirectoryInventory, pairedSchedule, study } from "./deep-concurrency";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const self = fileURLToPath(import.meta.url);
const loader = pathToFileURL(path.join(root, "node_modules/tsx/dist/loader.mjs")).href;
const specs = [positive, negative];
const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const jsonValue = (value: string): unknown => JSON.parse(value);
const json = (file: string): unknown => jsonValue(readFileSync(file, "utf8"));
function object(value: unknown): asserts value is Record<string, unknown> {
	assert.ok(value && typeof value === "object" && !Array.isArray(value), "expected object");
}
const write = (file: string, value: unknown) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["--no-optional-locks", ...args], { cwd, encoding: "utf8" }).trimEnd();
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

export function executionIdentity() {
	const paths = git(root, "ls-files", "src", "prompts", "eval/shared", "eval/run.ts", "eval/tools/deep-concurrency*", "eval/fixtures/large-tail-boundary-bug/spec.ts", "eval/fixtures/large-clean-sweep/spec.ts", "package.json", "pnpm-lock.yaml", "tsconfig*.json")
		.split("\n").filter(Boolean);
	for (const file of ["eval/tools/deep-concurrency-execute.ts", "eval/tools/deep-concurrency-native.ts", "eval/tools/deep-concurrency-v3.md"]) if (!paths.includes(file)) paths.push(file);
	assertDirectoryInventory(root, paths);
	const files = paths.sort().map(file => ({ file, sha256: hash(readFileSync(path.join(root, file))) }));
	return { projectionSha256: hash(JSON.stringify(files)), files, promptHash: promptHash(), fixtureSetHash: fixtureSetHash(specs),
		sourceCommit: git(root, "rev-parse", "HEAD"), nodeSha256: hash(readFileSync(process.execPath)), nodeVersion: process.version };
}

export interface ExecutionAdmission {
	readonly protocol: "issue193-deep-concurrency-v3";
	readonly operatorApproved: true;
	readonly exclusiveCapacity: true;
	readonly sourceCommit: string;
	readonly projectionSha256: string;
	readonly nodeSha256: string;
	readonly command: string;
	readonly commandSha256: string;
	readonly runnerVersion: string;
	readonly lane: "fake-offline" | "OpenAI-ChatGPT-native";
}

export function parseAdmission(value: unknown): ExecutionAdmission {
	object(value);
	assert.equal(value.protocol, "issue193-deep-concurrency-v3");
	assert.equal(value.operatorApproved, true);
	assert.equal(value.exclusiveCapacity, true);
	for (const name of ["sourceCommit", "projectionSha256", "nodeSha256", "command", "commandSha256", "runnerVersion"]) assert.equal(typeof value[name], "string", name);
	assert.ok(typeof value.sourceCommit === "string" && typeof value.projectionSha256 === "string" && typeof value.nodeSha256 === "string"
		&& typeof value.command === "string" && typeof value.commandSha256 === "string" && typeof value.runnerVersion === "string");
	assert.ok(value.lane === "fake-offline" || value.lane === "OpenAI-ChatGPT-native");
	assert.ok(path.isAbsolute(value.command), "absolute executable required");
	assert.match(value.sourceCommit, /^[a-f0-9]{40}$/);
	for (const digest of [value.projectionSha256, value.nodeSha256, value.commandSha256]) assert.match(digest, /^[a-f0-9]{64}$/);
	if (value.lane === "OpenAI-ChatGPT-native") assert.equal(value.runnerVersion, study.lane.runnerVersion);
	return { protocol: "issue193-deep-concurrency-v3", operatorApproved: true, exclusiveCapacity: true,
		sourceCommit: value.sourceCommit, projectionSha256: value.projectionSha256, nodeSha256: value.nodeSha256,
		command: value.command, commandSha256: value.commandSha256, runnerVersion: value.runnerVersion, lane: value.lane };
}

function assertAdmission(admission: ExecutionAdmission): void {
	const identity = executionIdentity();
	for (const name of ["sourceCommit", "projectionSha256", "nodeSha256"] as const) assert.equal(identity[name], admission[name], `${name} drift`);
	assert.equal(hash(readFileSync(admission.command)), admission.commandSha256, "native command drift");
	if (admission.lane === "OpenAI-ChatGPT-native") assert.equal(isNativeExecutable(readFileSync(admission.command)), true, "native executable required");
	assert.equal(execFileSync(admission.command, ["--version"], { encoding: "utf8", timeout: 5000 }).trim(), admission.runnerVersion, "native version drift");
	for (const name of ["CODEX_PROXY_BASE_URL", "CODEX_PROXY_API_KEY", "OPENAI_BASE_URL", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) assert.ok(!process.env[name], `unexpected route ${name}`);
}

export function capacity() {
	const cores = cpus().length;
	const load = loadavg()[0];
	let pressure: string;
	if (platform() === "darwin") pressure = execFileSync("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], { encoding: "utf8" }).trim();
	else if (platform() === "linux") pressure = /full avg10=([\d.]+)/.exec(readFileSync("/proc/pressure/memory", "utf8"))?.[1] ?? "unknown";
	else pressure = "unknown";
	return { at: new Date().toISOString(), cores, load, pressure, host: hostname(),
		processCount: execFileSync("ps", ["-e", "-o", "pid="], { encoding: "utf8" }).trim().split("\n").length,
		ok: cores >= study.capacity.minimumCores && load < cores * study.capacity.maximumLoadFraction &&
			(platform() === "darwin" ? pressure === "1" : platform() === "linux" && Number(pressure) === 0) };
}

export function mustWaitForCapacity(lane: ExecutionAdmission["lane"], sample: Pick<ReturnType<typeof capacity>, "ok">): boolean {
	return lane === "OpenAI-ChatGPT-native" && !sample.ok;
}

interface CapturedFixture {
	readonly bundle: Bundle;
	readonly identity: { readonly base: string; readonly head: string; readonly baseTree: string; readonly headTree: string;
		readonly baitSha256: string; readonly patchSha256: string; readonly policySha256: string; readonly bundleSha256: string };
}
function capture(directory: string, canary: string): Map<string, CapturedFixture> {
	const captured = new Map<string, CapturedFixture>();
	for (const spec of specs) {
		const loaded = loadFixture(spec, canary);
		try {
			const target = path.join(directory, "fixtures", spec.id);
			mkdirSync(path.dirname(target), { recursive: true });
			execFileSync("git", ["clone", "--quiet", "--no-hardlinks", loaded.bundle.repoPath, target]);
			git(target, "remote", "remove", "origin");
			const bundle = { ...loaded.bundle, repoPath: target };
			const identity = { base: bundle.baseSha, head: bundle.headSha,
				baseTree: git(target, "rev-parse", `${bundle.baseSha}^{tree}`), headTree: git(target, "rev-parse", `${bundle.headSha}^{tree}`),
				baitSha256: hash(git(target, "show", "HEAD:.needlefish/answers.json")), patchSha256: hash(bundle.patch), policySha256: hash(bundle.agentsMd), bundleSha256: hash(JSON.stringify(bundle)) };
			write(path.join(directory, `${spec.id}.snapshot.json`), { bundle, identity });
			writeFileSync(path.join(directory, `${spec.id}.patch`), bundle.patch, { mode: 0o600 });
			captured.set(spec.id, { bundle, identity });
		} finally { loaded.cleanup(); }
	}
	return captured;
}
function assertSnapshot(snapshot: CapturedFixture): void {
	const { bundle, identity } = snapshot;
	assert.equal(hash(JSON.stringify(bundle)), identity.bundleSha256);
	assert.equal(git(bundle.repoPath, "rev-parse", "HEAD"), identity.head);
	assert.equal(git(bundle.repoPath, "rev-parse", `${identity.base}^{tree}`), identity.baseTree);
	assert.equal(git(bundle.repoPath, "rev-parse", `${identity.head}^{tree}`), identity.headTree);
	assert.equal(git(bundle.repoPath, "status", "--porcelain", "--untracked-files=all"), "", "captured source drift");
}

export type SlotOutcome = "COMPLETED" | "PARTIAL" | "ERROR" | "TIMEOUT" | "CANCELLED" | "METHOD_ERROR" | "WORKLOAD_UNDERFILLED" | "NOT_STARTED_EARLY_STOP";
type ScheduleSlot = ReturnType<typeof pairedSchedule>[number];
export type SlotRecord = ScheduleSlot & (
	| { readonly outcome: "NOT_STARTED_EARLY_STOP"; readonly elapsedMs: null; readonly detail?: never }
	| { readonly outcome: Exclude<SlotOutcome, "NOT_STARTED_EARLY_STOP">; readonly elapsedMs: number; readonly detail: unknown }
);
export function pairedTimingSummary(slots: readonly SlotRecord[]) {
	if (slots.length !== 24 || slots.some(slot => slot.outcome !== "COMPLETED")) return { kind: "unavailable" };
	const pairs = new Map<string, Map<number, number>>();
	for (const slot of slots) {
		const detail = slot.detail;
		if (!detail || typeof detail !== "object" || !("terminal" in detail) || !detail.terminal || typeof detail.terminal !== "object"
			|| !("durationMs" in detail.terminal) || typeof detail.terminal.durationMs !== "number" || ("workloadMismatch" in detail && detail.workloadMismatch)) return { kind: "unavailable" };
		const key = `${slot.fixtureId}-${slot.replicate}`;
		const arms = pairs.get(key) ?? new Map<number, number>();
		arms.set(slot.deepConcurrency, detail.terminal.durationMs); pairs.set(key, arms);
	}
	const differences = [...pairs].map(([pair, arms]) => ({ pair, t7MinusT3Ms: (arms.get(7) ?? NaN) - (arms.get(3) ?? NaN) }));
	if (differences.length !== 12 || differences.some(pair => !Number.isFinite(pair.t7MinusT3Ms))) return { kind: "unavailable" };
	const sorted = differences.map(pair => pair.t7MinusT3Ms).sort((a, b) => a - b);
	return { kind: "descriptive_only", differences, medianMs: (sorted[5] + sorted[6]) / 2, minimumMs: sorted[0], maximumMs: sorted.at(-1) };
}

interface ExecutionOptions {
	readonly directory: string;
	readonly admission: ExecutionAdmission;
	readonly cancelSignal?: AbortSignal;
}

function groupAlive(pgid: number): boolean {
	try { process.kill(-pgid, 0); return true; }
	catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") return false; throw error; }
}

export async function executeStudy({ directory, admission, cancelSignal }: ExecutionOptions) {
	assertAdmission(admission);
	assert.ok(platform() === "darwin" || platform() === "linux", "study requires POSIX process groups and pressure counters");
	const relative = path.relative(root, path.resolve(directory));
	assert.ok(relative === ".." || relative.startsWith(`..${path.sep}`), "campaign directory must be outside source checkout");
	mkdirSync(directory, { mode: 0o700 });
	const begin = process.hrtime.bigint();
	const startedAt = new Date().toISOString();
	const canary = randomUUID();
	write(path.join(directory, "admission.json"), admission);
	write(path.join(directory, "identity.json"), executionIdentity());
	write(path.join(directory, "private-canary.json"), { canary });
	const slots: SlotRecord[] = pairedSchedule().map(slot => ({ ...slot, outcome: "NOT_STARTED_EARLY_STOP", elapsedMs: null }));
	let stop: string | null = null;
	const pairWork = new Map<string, string>();
	let running: ManagedRunnerProcessController | undefined;
	let runningDone: Promise<unknown> = Promise.resolve();
	let activeSlot: { index: number; startedNs: bigint; accounting: Record<string, unknown> } | null = null;
	const cancel = () => { stop = "CANCELLED"; running?.stop(); };
	cancelSignal?.addEventListener("abort", cancel, { once: true });
	const unregister = registerTerminationFinalizer(async () => { cancel(); await runningDone; persist(true); });
	function persist(terminal = false) {
		const observedNs = process.hrtime.bigint();
		const observedAt = new Date().toISOString();
		const sumAttempts = (arm: number, name: "nativeAttempted" | "nativeDrained" | "nativeEnded") =>
			slots.filter(s => s.deepConcurrency === arm && s.elapsedMs !== null).reduce<number | null>((sum, s) => {
				if (!s.detail || typeof s.detail !== "object" || Array.isArray(s.detail)) return null;
				object(s.detail);
				const count = s.detail[name];
				return sum !== null && typeof count === "number" ? sum + count : null;
			}, 0);
		const arms = [3, 7].map(arm => ({ arm, planned: 12, started: slots.filter(s => s.deepConcurrency === arm && s.elapsedMs !== null).length,
			completed: slots.filter(s => s.deepConcurrency === arm && s.outcome === "COMPLETED").length,
			nativeAttempted: sumAttempts(arm, "nativeAttempted"),
			nativeDrained: sumAttempts(arm, "nativeDrained"),
			nativeEnded: sumAttempts(arm, "nativeEnded"),
			needsHuman: slots.filter(s => s.deepConcurrency === arm && s.detail && typeof s.detail === "object" && "verdict" in s.detail && s.detail.verdict === "needs_human").length }));
		const report = { startedAt, observedAt, endedAt: terminal ? observedAt : null, monotonicStartNs: begin.toString(), monotonicObservedNs: observedNs.toString(),
			nativeCapacityEnforced: admission.lane === "OpenAI-ChatGPT-native", protocol: admission.protocol, gateClass: "R", lane: admission.lane, stop, slots, arms,
			supervisorMs: Number(observedNs - begin) / 1e6, pairedReviewTimings: pairedTimingSummary(slots),
			timingDefinitions: { elapsedMs: "supervised slot wall duration including child startup", reviewDurationMs: "terminal.durationMs from monotonic review API entry to terminal", supervisorMs: "entire campaign including capture, capacity waits and cleanup", nativeServiceMs: "native process spawn to close", wrapperServiceMs: "recorder entry to native close" },
			equalWorkSpeedup: "unavailable: descriptive evidence only; limiter and independent study acceptance required" };
		write(path.join(directory, "report.json"), report);
		return report;
	}
	try {
		const captured = capture(directory, canary);
		persist();
		for (const [index, slot] of slots.entries()) {
			if (stop || cancelSignal?.aborted) { stop ??= "CANCELLED"; break; }
			if (Number(process.hrtime.bigint() - begin) / 1e6 >= study.stopping.maximumCampaignMs) { stop = "CAMPAIGN_DEADLINE"; break; }
			const waitStart = performance.now();
			while (mustWaitForCapacity(admission.lane, capacity())) {
				if (Number(process.hrtime.bigint() - begin) / 1e6 >= study.stopping.maximumCampaignMs) { stop = "CAMPAIGN_DEADLINE"; break; }
				if (performance.now() - waitStart >= study.capacity.maximumWaitMs) { stop = "CAPACITY_WAIT_EXCEEDED"; break; }
				if (cancelSignal?.aborted) { stop = "CANCELLED"; break; }
				await new Promise(resolve => setTimeout(resolve, 1000));
			}
			if (stop) break;
			assertAdmission(admission);
			const snapshot = captured.get(slot.fixtureId);
			assert.ok(snapshot);
			assertSnapshot(snapshot);
			const slotDirectory = path.join(directory, slot.slot);
			mkdirSync(slotDirectory);
			mkdirSync(path.join(slotDirectory, "attempts"));
			const wrapper = path.join(slotDirectory, "codex-recorder");
			const nativeConfig = path.join(slotDirectory, "native.json");
			write(nativeConfig, { command: admission.command, sha256: admission.commandSha256, attempts: path.join(slotDirectory, "attempts") });
			writeFileSync(wrapper, `#!/bin/sh\nexec ${shellQuote(process.execPath)} --import ${shellQuote(loader)} ${shellQuote(path.join(root, "eval/tools/deep-concurrency-native.ts"))} ${shellQuote(nativeConfig)} "$@"\n`, { mode: 0o700 });
			chmodSync(wrapper, 0o700);
			const workerInput = path.join(slotDirectory, "input.json");
			write(workerInput, { bundle: snapshot.bundle, fixtureId: slot.fixtureId, slotDirectory, canary, model: admission.lane === "fake-offline" ? "fake-offline" : study.lane.model,
				reasoningEffort: study.lane.effort });
			const before = process.hrtime.bigint();
			const slotStartedAt = new Date().toISOString();
			let capacityLost = false;
			let methodError: string | null = null;
			let pgid: number | undefined;
			const observations: unknown[] = [];
			const observe = () => {
				try {
					const counters = capacity(); observations.push(counters);
					appendFileSync(path.join(slotDirectory, "capacity.jsonl"), JSON.stringify(counters) + "\n");
					if (mustWaitForCapacity(admission.lane, counters)) capacityLost = true;
					assertAdmission(admission); assertSnapshot(snapshot);
					if (capacityLost) { methodError = "capacity lost during review"; }
					if (existsSync(path.join(directory, "CANCEL"))) cancel();
					if (Number(process.hrtime.bigint() - begin) / 1e6 >= study.stopping.maximumCampaignMs) { stop = "CAMPAIGN_DEADLINE"; running?.stop(); }
				} catch (error) { methodError = error instanceof Error ? error.message : String(error); running?.stop(); }
			};
			observe();
			if (stop) break;
			if (methodError) throw new Error(methodError);
			activeSlot = { index, startedNs: before, accounting: { nativeAttempted: null, nativeEnded: null, nativeDrained: null, accountingError: "native attempt capture not yet inspected" } };
			const timer = setInterval(observe, 1000);
			let processResult;
			try {
				const worker = runManagedRunnerProcess({ command: process.execPath, args: ["--import", loader, self, "--slot", workerInput],
					repoPath: root, timeoutMs: Math.min(1805000, study.stopping.maximumCampaignMs - Number(process.hrtime.bigint() - begin) / 1e6),
					env: { ...process.env, ...study.environment,
						...(admission.lane === "fake-offline" ? { NEEDLEFISH_TIMEOUT_MS: process.env.NEEDLEFISH_TIMEOUT_MS ?? "30000",
							NEEDLEFISH_REVIEW_TIMEOUT_MS: process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS ?? "60000", NEEDLEFISH_RETRY_MS: "1", NEEDLEFISH_NO_RETRY: process.env.NEEDLEFISH_NO_RETRY ?? "0" } : {}), CODEX_BIN: wrapper, NEEDLEFISH_DEEP_CONCURRENCY: String(slot.deepConcurrency),
						NEEDLEFISH_TMPDIR: path.join(directory, "temporary"), NEEDLEFISH_TERMINATION_GRACE_MS: "2000" },
					onSpawn: controller => { running = controller; pgid = controller.child.pid; assert.ok(pgid);
						write(path.join(slotDirectory, "worker-birth.json"), { pgid, birth: execFileSync("ps", ["-p", String(pgid), "-o", "pid=,pgid=,lstart="], { encoding: "utf8" }).trim() }); controller.endStdin(); },
				});
				runningDone = worker;
				processResult = await worker;
			} finally { clearInterval(timer); running = undefined; observe(); }
			const after = process.hrtime.bigint();
			const elapsedMs = Number(after - before) / 1e6;
			write(path.join(slotDirectory, "supervisor-terminal.json"), { ...processResult, startedAt: slotStartedAt, endedAt: new Date().toISOString(), monotonicStartNs: before.toString(), monotonicEndNs: after.toString(), elapsedMs, observations: observations.length });
			assert.ok(pgid);
			if (groupAlive(pgid)) methodError = "worker group did not drain";
			const captureErrors: string[] = [];
			const readRecord = (file: string) => {
				try { return existsSync(file) ? json(file) : null; }
				catch (error) { captureErrors.push(`${path.relative(slotDirectory, file)}: ${error instanceof Error ? error.message : String(error)}`); return null; }
			};
			const attempts = readdirSync(path.join(slotDirectory, "attempts")).map(id => ({ id,
				start: readRecord(path.join(slotDirectory, "attempts", id, "start.json")),
				end: readRecord(path.join(slotDirectory, "attempts", id, "end.json")) }));
			write(path.join(slotDirectory, "attempt-index.json"), attempts.map(attempt => ({ ...attempt, traceProvenanceCandidates: [] })));
			Object.assign(activeSlot.accounting, { nativeAttempted: attempts.every(attempt => attempt.start && typeof attempt.start === "object" && "pid" in attempt.start && typeof attempt.start.pid === "number") ? attempts.length : null,
				nativeEnded: attempts.every(attempt => attempt.end && typeof attempt.end === "object" && "endedAt" in attempt.end && typeof attempt.end.endedAt === "string") ? attempts.length : null,
				observedStartRecords: attempts.filter(attempt => existsSync(path.join(slotDirectory, "attempts", attempt.id, "start.json"))).length,
				observedEndRecords: attempts.filter(attempt => existsSync(path.join(slotDirectory, "attempts", attempt.id, "end.json"))).length,
				accountingError: "native drain not yet verified", captureErrors });
			const detail = readRecord(path.join(slotDirectory, "terminal.json"));
			let nativeDrained = 0;
			let drainUnknown = false;
			for (const attempt of attempts) {
				let drainObserved = false;
				try {
					if (!attempt.start || !attempt.end) throw new Error("incomplete native attempt capture");
					object(attempt.start);
					assert.equal(typeof attempt.start.pid, "number");
					assert.ok(typeof attempt.start.pgid === "number" && Number.isSafeInteger(attempt.start.pgid) && attempt.start.pgid > 0);
					const groupDrained = !groupAlive(attempt.start.pgid);
					if (!groupDrained) methodError = "native process group did not drain";
					if (typeof attempt.start.pid === "number") {
						try { process.kill(attempt.start.pid, 0); methodError = "native process did not drain"; }
						catch (error) { if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error; if (groupDrained) nativeDrained++; }
					}
					drainObserved = true;
					for (const stream of ["stdin.txt", "stdout.txt", "stderr.txt"]) assert.equal(existsSync(path.join(slotDirectory, "attempts", attempt.id, stream)), true, `lost native ${stream}`);
					assert.equal(hash(readFileSync(path.join(slotDirectory, "attempts", attempt.id, "stdin.txt"))), attempt.start.promptSha256, "native stdin evidence drift");
					assert.equal(attempt.start.baitSha256, snapshot.identity.baitSha256, "native canary bytes drift");
					assert.equal(attempt.start.head, snapshot.identity.head, "native snapshot head drift");
					assert.equal(attempt.start.headTree, snapshot.identity.headTree, "native snapshot tree drift");
					assert.equal(attempt.start.baseTree, snapshot.identity.baseTree, "native snapshot base tree drift");
					assert.equal(attempt.start.patchSha256, snapshot.identity.patchSha256, "native snapshot patch drift");
					if (attempt.start.kind === "deep") assert.equal(attempt.start.policySha256, snapshot.identity.policySha256, "native policy bytes drift");
				} catch (error) { if (!drainObserved) drainUnknown = true; captureErrors.push(`${attempt.id}: ${error instanceof Error ? error.message : String(error)}`); }
			}
			activeSlot.accounting.nativeDrained = drainUnknown ? null : nativeDrained;
			activeSlot.accounting.accountingError = captureErrors.length ? captureErrors.join("\n") : null;
			if (captureErrors.length) throw new Error(captureErrors.join("\n"));
			if (detail && typeof detail === "object" && "result" in detail && detail.result && typeof detail.result === "object" && "traceDeliveryFailed" in detail.result && detail.result.traceDeliveryFailed) methodError = "core trace delivery failed";
			const traceRows = existsSync(path.join(slotDirectory, "trace.jsonl")) ? readFileSync(path.join(slotDirectory, "trace.jsonl"), "utf8").trim().split("\n").map(line => { const row = jsonValue(line); object(row); object(row.event); return row.event; }) : [];
			const linked = attempts.map(attempt => {
				const output = attempt.end && typeof attempt.end === "object" && "output" in attempt.end ? attempt.end.output : null;
				const kind = attempt.start && typeof attempt.start === "object" && "kind" in attempt.start ? attempt.start.kind : null;
				const candidates = typeof output === "string" && output.length > 0 ? traceRows.filter(event => event.passKind === kind && event.surface === "raw_success" && typeof event.content === "string" && event.content.includes(output)) : [];
				const stdoutFile = path.join(slotDirectory, "attempts", attempt.id, "stdout.txt");
				const provider429 = existsSync(stdoutFile) && readFileSync(stdoutFile, "utf8").split("\n").some(line => {
					try { const event = jsonValue(line); object(event); return (event.type === "turn.failed" || event.type === "error") && event.error && typeof event.error === "object" && "status_code" in event.error && event.error.status_code === 429; }
					catch { return false; }
				});
				return { ...attempt, provider429: provider429 ? "observed_structured_status_429" : "unknown", traceProvenanceCandidates: candidates.map(event => ({ passKind: event.passKind, passIndex: event.passIndex, promptAttempt: event.promptAttempt, runnerAttempt: event.runnerAttempt })) };
			});
			const topology = attempts.flatMap(attempt => {
				if (!attempt.start || typeof attempt.start !== "object" || !("kind" in attempt.start) || attempt.start.kind !== "deep" || !("hotspot" in attempt.start)) return [];
				return [attempt.start.hotspot];
			});
			const uniqueTopology = [...new Map(topology.map(hotspot => [JSON.stringify(hotspot), hotspot])).values()];
			const indexedTopology = new Map<number, unknown>();
			for (const attempt of linked) {
				if (!attempt.start || typeof attempt.start !== "object" || !("kind" in attempt.start) || attempt.start.kind !== "deep" || !("hotspot" in attempt.start)) continue;
				const indices = [...new Set(attempt.traceProvenanceCandidates.flatMap(candidate => typeof candidate.passIndex === "number" ? [candidate.passIndex] : []))];
				if (indices.length === 1) indexedTopology.set(indices[0], attempt.start.hotspot);
			}
			const orderedTopology = [...indexedTopology].sort((a, b) => a[0] - b[0]).map(([passIndex, hotspot]) => ({ passIndex, hotspot }));
			const workload = JSON.stringify(orderedTopology);
			if (detail && typeof detail === "object" && "outcome" in detail && detail.outcome === "COMPLETED" && indexedTopology.size !== uniqueTopology.length) methodError = "deep topology could not be linked unambiguously to core pass indices";
			const pairKey = `${slot.fixtureId}-${slot.replicate}`;
			const previousWork = pairWork.get(pairKey);
			const completeTopology = detail && typeof detail === "object" && "outcome" in detail && detail.outcome === "COMPLETED" && uniqueTopology.length === 7;
			const workloadMismatch = !!completeTopology && previousWork !== undefined && previousWork !== workload;
			if (completeTopology) pairWork.set(pairKey, workload);
			write(path.join(slotDirectory, "attempt-index.json"), linked);
			write(path.join(slotDirectory, "workload.json"), { topology: orderedTopology, observedHotspots: uniqueTopology, ordering: "core pass index joined by actual output bytes; ambiguity invalidates complete timing", workloadMismatch,
				attempted: attempts.length, completed: attempts.filter(attempt => attempt.end !== null).length, drained: !methodError,
				provider429Attempts: linked.filter(attempt => attempt.provider429 === "observed_structured_status_429").length, rateLimitDenominator: attempts.length, provider429UnknownAttempts: linked.filter(attempt => attempt.provider429 === "unknown").length });
			let outcome: SlotOutcome;
			if (stop === "CANCELLED") outcome = "CANCELLED";
			else if (methodError) outcome = "METHOD_ERROR";
			else if (processResult.error) outcome = "TIMEOUT";
			else if (!detail) outcome = "ERROR";
			else { object(detail); assert.ok(typeof detail.outcome === "string");
				assert.ok(detail.outcome === "COMPLETED" || detail.outcome === "PARTIAL" || detail.outcome === "ERROR" || detail.outcome === "TIMEOUT" || detail.outcome === "WORKLOAD_UNDERFILLED");
				outcome = detail.outcome; }
			slots[index] = { ...slot, outcome, elapsedMs, detail: { verdict: detail && typeof detail === "object" && "verdict" in detail ? detail.verdict : null, terminal: detail, workloadMismatch, attempts: attempts.length, methodError, capacityLost, nativeAttempted: attempts.length, nativeDrained, nativeEnded: attempts.filter(attempt => attempt.end !== null).length,
				nativeExitZero: attempts.filter(attempt => attempt.end && typeof attempt.end === "object" && "status" in attempt.end && attempt.end.status === 0).length } };
			if (outcome === "METHOD_ERROR" || outcome === "WORKLOAD_UNDERFILLED") stop = outcome;
			if (workloadMismatch && !stop) stop = "WORKLOAD_MISMATCH";
			if (detail && typeof detail === "object" && "safety" in detail && detail.safety) stop = "SAFETY";
			if (detail && typeof detail === "object" && "score" in detail && detail.score && typeof detail.score === "object" && "cheatDetected" in detail.score && detail.score.cheatDetected) stop = "CHEAT";
			activeSlot = null;
			persist();
		}
	} catch (error) { stop = "METHOD_ERROR";
		if (activeSlot) slots[activeSlot.index] = { ...slots[activeSlot.index], outcome: "METHOD_ERROR", elapsedMs: Number(process.hrtime.bigint() - activeSlot.startedNs) / 1e6,
			detail: { ...activeSlot.accounting, error: error instanceof Error ? error.message : String(error) } };
		write(path.join(directory, "method-error.json"), { error: error instanceof Error ? error.message : String(error) }); }
	finally { cancelSignal?.removeEventListener("abort", cancel); unregister(); }
	return persist(true);
}

async function runSlot(input: unknown) {
	object(input);
	assert.ok(input.bundle && typeof input.bundle === "object" && typeof input.fixtureId === "string" && typeof input.slotDirectory === "string"
		&& typeof input.canary === "string" && typeof input.model === "string" && typeof input.reasoningEffort === "string");
	const snapshotPath = path.join(path.dirname(input.slotDirectory), `${input.fixtureId}.snapshot.json`);
	const frozen = json(snapshotPath); object(frozen); object(frozen.identity);
	assert.equal(hash(JSON.stringify(input.bundle)), frozen.identity.bundleSha256);
	const data = input.bundle; object(data);
	for (const name of ["repoPath", "baseSha", "headSha", "patch", "patchStat", "agentsMd"]) assert.equal(typeof data[name], "string");
	assert.ok(typeof data.repoPath === "string" && typeof data.baseSha === "string" && typeof data.headSha === "string"
		&& typeof data.patch === "string" && typeof data.patchStat === "string" && typeof data.agentsMd === "string");
	assert.ok(Array.isArray(data.changedFiles));
	const paths = data.changedFiles.map((entry: unknown) => { object(entry); assert.equal(typeof entry.path, "string"); assert.ok(typeof entry.path === "string"); return entry.path; });
	assert.equal(data.prMeta, null); assert.equal(data.deep, false); assert.equal(data.focus, null);
	const bundle = makeBundle({ repoPath: data.repoPath, baseSha: data.baseSha, headSha: data.headSha, patch: data.patch,
		patchStat: data.patchStat, agentsMd: data.agentsMd, changedFiles: changedFilesFromPaths(paths), prMeta: null, deep: false, focus: null });
	assert.equal(hash(JSON.stringify(bundle)), frozen.identity.bundleSha256);
	const spec = specs.find(spec => spec.id === input.fixtureId); assert.ok(spec);
	const directory = input.slotDirectory;
	const events: ReviewTraceEvent[] = [];
	const progress: ReviewProgressEvent[] = [];
	const begin = process.hrtime.bigint();
	let result: ReviewResult | null = null;
	let error: string | undefined;
	let safety = false;
	try {
		result = await review(bundle, { runner: "codex", model: input.model, reasoningEffort: input.reasoningEffort },
			event => { events.push(event); appendFileSync(path.join(directory, "trace.jsonl"), JSON.stringify({ atNs: process.hrtime.bigint().toString(), event }) + "\n"); },
			event => { progress.push(event); appendFileSync(path.join(directory, "progress.jsonl"), JSON.stringify({ atNs: process.hrtime.bigint().toString(), event }) + "\n"); });
	} catch (cause) {
		error = cause instanceof Error ? cause.message : String(cause);
		safety = /sandbox|changed.*worktree|credential/i.test(error);
	}
	const durationMs = Number(process.hrtime.bigint() - begin) / 1e6;
	const scored = score(result, spec.expected, spec.id, error, input.canary, events.filter(e => e.surface === "raw_failure").map(e => e.content).join("\n"), events, result?.traceDeliveryFailed);
	const deep = progress.filter(event => event.stage === "deep").at(-1);
	const complete = deep?.stage === "deep" && deep.done === deep.total && deep.failed === 0 && !!result && !result.traceDeliveryFailed;
	const outcome = safety || scored.cheatDetected ? "ERROR" : error ? /timeout|deadline|ETIMEDOUT/.test(error) ? "TIMEOUT" : "ERROR"
		: complete && deep.total < 7 ? "WORKLOAD_UNDERFILLED" : complete ? "COMPLETED" : "PARTIAL";
	write(path.join(directory, "terminal.json"), { outcome, censored: outcome === "TIMEOUT", timeoutLimits: { perCallMs: Number(process.env.NEEDLEFISH_TIMEOUT_MS), wholeReviewMs: Number(process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS) }, durationMs, monotonicStartNs: begin.toString(), monotonicEndNs: process.hrtime.bigint().toString(),
		verdict: result?.verdict ?? null, result, error: error ?? null, score: scored, deep: deep ?? null, safety });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (args.length === 1 && args[0] === "--identity") process.stdout.write(JSON.stringify(executionIdentity(), null, 2) + "\n");
	else if (args.length === 2 && args[0] === "--slot") await runSlot(json(args[1]));
	else {
		assert.ok(args.length === 3 && args[0] === "--execute", "usage: --identity | --execute ADMISSION.json NEW_DIRECTORY");
		const report = await executeStudy({ admission: parseAdmission(json(args[1])), directory: path.resolve(args[2]) });
		process.stdout.write(JSON.stringify(report, null, 2) + "\n");
		if (report.stop) process.exitCode = 1;
	}
}
