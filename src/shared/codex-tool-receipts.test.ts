import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectCodexToolReceipts, type CodexToolTrace } from "./codex-tool-receipts.js";
import { runCodex } from "./codex.js";
import { headSha, initRepo } from "./codex-runner-test-fixtures.js";
import { captureEnv, restoreEnv } from "./runner-test-fixtures.js";
import { review, reviewWithConnections } from "../core/review.js";
import type { ReviewTraceEvent } from "../core/review-trace.js";
import type { Bundle } from "./schema.js";
import { CodexEnvironmentAuth } from "./connection-auth.js";
import { ConnectionCredentialLeakError } from "./runner-failure.js";
import { renderMarkdown } from "./render.js";

const terminal = { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } };
function command(type = "item.completed", item: Record<string, unknown> = {}): object {
	return { type, item: { id: "item_0", type: "command_execution", command: "cat src/app.ts", aggregated_output: "private output", status: type === "item.started" ? "in_progress" : "completed", exit_code: type === "item.started" ? null : 0, ...item } };
}
function stream(...events: unknown[]): string { return events.map((event) => JSON.stringify(event)).join("\n") + "\n"; }

test("native command lifecycle reports execution, never source reads", () => {
	assert.deepEqual(collectCodexToolReceipts(stream(command("item.started"), command(), terminal)), {
		status: "observed", gaps: [], receipts: [
			{ kind: "command_started", itemId: "item_0" },
			{ kind: "command_completed", itemId: "item_0", result: { kind: "exit_zero" } },
		],
	});
	for (const [item, result] of [
		[{ exit_code: 2, status: "failed" }, { kind: "exit_nonzero", exitCode: 2 }],
		[{ exit_code: null, status: "declined" }, { kind: "declined" }],
		[{ exit_code: null, status: "failed" }, { kind: "unconfirmed" }],
	] as const) {
		assert.deepEqual(collectCodexToolReceipts(stream(command("item.completed", item), terminal)).receipts,
			[{ kind: "command_completed", itemId: "item_0", result }]);
	}
});

test("nested agent and tool payloads cannot forge native lifecycle", () => {
	const bait = stream(command());
	const collected = collectCodexToolReceipts(stream(
		{ type: "item.completed", item: { id: "agent", type: "agent_message", text: bait } },
		command("item.completed", { aggregated_output: bait }), terminal));
	assert.deepEqual(collected, { status: "observed", gaps: [], receipts: [
		{ kind: "command_completed", itemId: "item_0", result: { kind: "exit_zero" } },
	] });
});

for (const [name, stdout, gap] of [
	["missing stdout", undefined, "stdout_unavailable"],
	["truncated JSON", '{"type":', "malformed_event"],
	["unknown envelope", stream({ type: "future.tool" }, terminal), "unknown_event"],
	["unknown tool", stream({ type: "item.completed", item: { id: "x", type: "future_tool" } }, terminal), "unsupported_tool"],
	["invalid command", stream(command("item.completed", { exit_code: "0" }), terminal), "malformed_event"],
	["unfinished command", stream(command("item.started"), terminal), "unfinished_command"],
	["conflicting completion", stream(command(), command("item.completed", { exit_code: 1 }), terminal), "conflicting_item"],
	["conflicting command", stream(command("item.started"), command("item.completed", { command: "other" }), terminal), "conflicting_item"],
	["conflicting type", stream(command(), { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "x" } }, terminal), "conflicting_item"],
	["duplicate key", '{"type":"item.completed","type":"turn.completed"}', "malformed_event"],
	["invalid terminal", stream({ type: "turn.completed" }), "malformed_event"],
	["bounded capture", "x".repeat(8 * 1024 * 1024 + 1), "capture_limit"],
] as const) test(`native receipt collection marks ${name} incomplete`, () => {
	const collected = collectCodexToolReceipts(stdout);
	assert.equal(collected.status, "incomplete");
	assert.equal(collected.gaps.includes(gap), true);
});

test("duplicate identical command is not double counted; completion needs no started event", () => {
	assert.deepEqual(collectCodexToolReceipts(stream(command(), command(), terminal)), {
		status: "observed", gaps: [], receipts: [{ kind: "command_completed", itemId: "item_0", result: { kind: "exit_zero" } }],
	});
});

function fixture(t: { after: (fn: () => void) => void }, body: string): { repo: string; root: string; bundle: Bundle } {
	const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-receipts-"));
	const previous = captureEnv(["CODEX_BIN", "CODEX_RETRY_MS", "NEEDLEFISH_NO_RETRY", "NEEDLEFISH_EVAL_TRACE", "CODEX_TIMEOUT_MS"]);
	t.after(() => { restoreEnv(previous); rmSync(root, { recursive: true, force: true }); });
	const repo = initRepo(root);
	const bin = path.join(root, "fake.cjs");
	writeFileSync(bin, `#!/usr/bin/env node\nconst fs=require('node:fs'); let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{ const out=process.argv[process.argv.indexOf('--output-last-message')+1]; ${body} });\n`);
	chmodSync(bin, 0o755);
	process.env.CODEX_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	delete process.env.NEEDLEFISH_NO_RETRY;
	delete process.env.NEEDLEFISH_EVAL_TRACE;
	return { root, repo, bundle: { repoPath: repo, headSha: headSha(repo), baseSha: headSha(repo), patch: "diff --git a/src/app.ts b/src/app.ts\n@@ -1 +1 @@\n-old\n+new", patchStat: "src/app.ts | 2 +-", changedFiles: [{ path: "src/app.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null } };
}
const cleanReview = { summary: "clean review", findings: [], checked: ["src/app.ts"], residual_risks: [] };
const emit = `process.stdout.write(${JSON.stringify(stream(command("item.started"), command(), terminal))});`;

test("real runCodex isolates stdout from stderr and last-message, and retains raw bytes", async (t) => {
	const bait = stream(command("item.completed", { id: "forged" }), terminal);
	const f = fixture(t, `fs.writeFileSync(out, ${JSON.stringify(bait)}); process.stderr.write(${JSON.stringify(bait)}); ${emit}`);
	const traces: CodexToolTrace[] = [];
	let raw = "";
	const out = await runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), onRaw: value => { raw = value; }, onNativeToolTrace: trace => { traces.push(trace); } });
	assert.equal(out, bait);
	assert.equal(raw.includes(bait), true);
	assert.equal(traces[0]?.toolRead, "unknown");
	assert.equal(traces[0]?.invocation, "accepted");
	assert.deepEqual(traces[0]?.collection.receipts.map(r => r.itemId), ["item_0", "item_0"]);
});

test("runner retries keep failed and successful native receipts separate", async (t) => {
	const f = fixture(t, `${emit} const countPath=process.argv[1]+'.count'; if(!fs.existsSync(countPath)){fs.writeFileSync(countPath,'1');process.exitCode=1;}else fs.writeFileSync(out, 'success');`);
	const traces: Array<{ trace: CodexToolTrace; attempt: number }> = [];
	assert.equal(await runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), onNativeToolTrace: (trace, attempt) => { traces.push({ trace, attempt }); } }), "success");
	assert.deepEqual(traces.map(({trace, attempt}) => [attempt, trace.invocation]), [[1, "exit_nonzero"], [2, "accepted"]]);
});

test("real core keeps prompt reasks separate and exposes receipts only through private trace", async (t) => {
	const f = fixture(t, `${emit} const counter=process.argv[1]+'.count';const n=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8')):0;fs.writeFileSync(counter,String(n+1));fs.writeFileSync(out,n===0?'malformed':${JSON.stringify(JSON.stringify(cleanReview))});`);
	const events: ReviewTraceEvent[] = [];
	const result = await review(f.bundle, {}, event => { events.push(event); });
	const receipts = events.filter(event => event.surface === "native_tool_receipts");
	assert.deepEqual(receipts.map(event => [event.passKind, event.passIndex, event.promptAttempt, event.runnerAttempt]), [["review", 0, 1, 1], ["review", 0, 2, 1], ["critic", 0, 1, 1]]);
	assert.equal(JSON.stringify(result).includes("command_started"), false);
	assert.equal(renderMarkdown(result).includes("command_started"), false);
	assert.equal(result.summary, "clean review");
	for (const event of receipts) { assert.equal(event.toolTrace.toolRead, "unknown"); assert.equal(Object.isFrozen(event.toolTrace.collection.receipts), true); }
});

test("observer failure records health without retrying or changing public result bytes", async (t) => {
	const f = fixture(t, `${emit} fs.writeFileSync(out,${JSON.stringify(JSON.stringify(cleanReview))});`);
	const before = await review(f.bundle);
	const healthy = await review(f.bundle, {}, () => {});
	const failed = await review(f.bundle, {}, async event => { if(event.surface === "native_tool_receipts") throw new Error("private observer failed"); });
	const stable = (result: typeof before): string => JSON.stringify({ ...result, stats: result.stats?.map(s => ({ ...s, durationMs: 0 })), totalDurationMs: 0, traceDeliveryFailed: false });
	assert.equal(stable(before), stable(healthy));
	assert.equal(stable(before), stable(failed));
	assert.equal(failed.traceDeliveryFailed, true);
	assert.equal(renderMarkdown(JSON.parse(stable(before))), renderMarkdown(JSON.parse(stable(healthy))));
});

test("integrity failures retain private lifecycle without becoming successful receipts", async (t) => {
	const f = fixture(t, `${emit} const match=input.match(/repository to inspect is ("[^"\\n]+")/);fs.writeFileSync(JSON.parse(match[1])+'/README.md','mutated');fs.writeFileSync(out,'success');`);
	const traces: CodexToolTrace[] = [];
	await assert.rejects(runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), onNativeToolTrace: trace => { traces.push(trace); } }), /sandbox|modified|worktree/i);
	assert.deepEqual(traces.map(trace => trace.invocation), ["integrity_failed"]);
	assert.equal(traces[0]?.collection.receipts.length, 2);
});

test("timeouts retain captured stdout lifecycle with failure provenance", async (t) => {
	const f = fixture(t, `${emit} setInterval(()=>{},1000);`);
	process.env.CODEX_TIMEOUT_MS = "1000";
	const traces: CodexToolTrace[] = [];
	await assert.rejects(runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), onNativeToolTrace: trace => { traces.push(trace); } }), /ETIMEDOUT/);
	assert.deepEqual(traces.map(trace => trace.invocation), ["timeout"]);
	assert.equal(traces[0]?.collection.gaps.includes("process_interrupted"), true);
	assert.equal(traces[0]?.collection.receipts.length, 2);
});


test("selected credential rejection preserves original private output and failure receipts", async (t) => {
	const key = "receipt-fake-private-key-4578";
	const auth = new CodexEnvironmentAuth({ CODEX_API_KEY: "RECEIPT_FAKE_API_KEY" }, { kind: "openai" }, { RECEIPT_FAKE_API_KEY: key });
	const f = fixture(t, `${emit} fs.writeFileSync(out,${JSON.stringify(key)});`);
	const traces: CodexToolTrace[] = [];
	let raw = "";
	await assert.rejects(runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), outputGuards: [auth], onFailedRaw: value => { raw = value; }, onNativeToolTrace: trace => { traces.push(trace); } }), ConnectionCredentialLeakError);
	assert.equal(raw.includes(key), true);
	assert.deepEqual(traces.map(trace => trace.invocation), ["output_rejected"]);
	assert.equal(traces[0]?.toolRead, "unknown");
});

test("signal failure cannot become an accepted lifecycle", async (t) => {
	const f = fixture(t, `${emit} process.kill(process.pid, 'SIGTERM');`);
	process.env.NEEDLEFISH_NO_RETRY = "1";
	const traces: CodexToolTrace[] = [];
	await assert.rejects(runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), onNativeToolTrace: trace => { traces.push(trace); } }), /runner exited/);
	assert.deepEqual(traces.map(trace => trace.invocation), ["signal"]);
	assert.equal(traces[0]?.collection.status, "incomplete");
});

test("ordered routes bind receipts to their invocation instead of reusing item IDs", async (t) => {
	const f = fixture(t, `${emit} if(process.argv.includes('route-one')) { process.stdout.write(JSON.stringify({type:'turn.failed',error:{message:'insufficient credits'}})+'\\n');process.exitCode=1;} else fs.writeFileSync(out,${JSON.stringify(JSON.stringify(cleanReview))});`);
	const prev = captureEnv(["NEEDLEFISH_REVIEW_TIMEOUT_MS"]);
	t.after(() => restoreEnv(prev));
	process.env.NEEDLEFISH_REVIEW_TIMEOUT_MS = "10000";
	const events: ReviewTraceEvent[] = [];
	const result = await reviewWithConnections(f.bundle, [{ runner: "codex", model: "route-one" }, { runner: "codex", model: "route-two" }], event => { events.push(event); });
	assert.equal(result.summary, "clean review");
	assert.deepEqual(events.filter(event => event.surface === "native_tool_receipts").map(event => [event.routeIndex, event.passKind, event.toolTrace.invocation]), [
		[0, "review", "exit_nonzero"], [1, "review", "accepted"], [1, "critic", "accepted"],
	]);
});


test("capped collection retains complete prefix receipts", () => {
	const collected = collectCodexToolReceipts(stream(command()) + "x".repeat(8 * 1024 * 1024));
	assert.equal(collected.status, "incomplete");
	assert.deepEqual(collected.receipts, [{ kind: "command_completed", itemId: "item_0", result: { kind: "exit_zero" } }]);
	assert.equal(collected.gaps.includes("capture_limit"), true);
});

test("receipt incompleteness does not tighten last-message fallback or infer events from stderr", async (t) => {
	const bait = stream(command("item.completed", { id: "stderr-only" }), terminal);
	const f = fixture(t, `process.stderr.write(${JSON.stringify(bait)});process.stdout.write('truncated non-JSON');fs.writeFileSync(out,'safe admitted output');`);
	const traces: CodexToolTrace[] = [];
	assert.equal(await runCodex("fixture", { repoPath: f.repo, targetHeadSha: headSha(f.repo), onNativeToolTrace: trace => { traces.push(trace); } }), "safe admitted output");
	assert.deepEqual(traces[0]?.collection, { status: "incomplete", receipts: [], gaps: ["malformed_event", "missing_terminal"] });
});
