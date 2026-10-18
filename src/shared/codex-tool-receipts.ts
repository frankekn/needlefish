import { findDuplicateJsonKey } from "./json-keys.js";

export type CodexCommandReceipt =
	| { readonly kind: "command_started"; readonly itemId: string }
	| { readonly kind: "command_completed"; readonly itemId: string; readonly result:
		| { readonly kind: "exit_zero" }
		| { readonly kind: "exit_nonzero"; readonly exitCode: number }
		| { readonly kind: "declined" }
		| { readonly kind: "unconfirmed" } };

export type CodexReceiptGap = "stdout_unavailable" | "capture_limit" | "malformed_event" |
	"unknown_event" | "unsupported_tool" | "conflicting_item" | "unfinished_command" | "missing_terminal" | "unconfirmed_completion" | "process_interrupted";

export interface CodexToolTrace {
	readonly adapter: "codex";
	readonly transport: "exec_jsonl_stdout";
	// Parser contract, not attestation of the selected executable.
	readonly protocol: "rust-v0.163.0";
	readonly toolRead: "unknown";
	readonly invocation: "accepted" | "exit_nonzero" | "signal" | "timeout" |
		"process_error" | "integrity_failed" | "output_rejected" | "unknown";
	readonly collection: {
		readonly status: "observed" | "incomplete";
		readonly receipts: readonly CodexCommandReceipt[];
		readonly gaps: readonly CodexReceiptGap[];
	};
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

// This is an observer of native stdout, never an output-admission validator.
export function collectCodexToolReceipts(stdout: string | undefined): CodexToolTrace["collection"] {
	const receipts: CodexCommandReceipt[] = [];
	const gaps = new Set<CodexReceiptGap>();
	const items = new Map<string, { type: string; command?: string; started?: string; completed?: string }>();
	let terminal = false;
	if (stdout === undefined) gaps.add("stdout_unavailable");
	else {
		let captured = stdout;
		if (Buffer.byteLength(stdout) > 8 * 1024 * 1024) {
			gaps.add("capture_limit");
			const prefix = Buffer.from(stdout.slice(0, 8 * 1024 * 1024)).subarray(0, 8 * 1024 * 1024).toString("utf8");
			captured = prefix.slice(0, prefix.lastIndexOf("\n") + 1);
		}
		let lines = 0;
		for (const line of captured.split(/\r?\n/)) {
			if (!line.trim()) continue;
			if (++lines > 100000) { gaps.add("capture_limit"); break; }
			let event: unknown;
			try {
				if (findDuplicateJsonKey(line) !== undefined) throw new Error("duplicate key");
				event = JSON.parse(line);
			}
			catch { gaps.add("malformed_event"); continue; }
			if (!record(event)) { gaps.add("malformed_event"); continue; }
			if (event.type === "turn.completed" || event.type === "turn.failed") {
				const valid = event.type === "turn.failed" ? record(event.error) && typeof event.error.message === "string" :
					record(event.usage) && ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens"]
						.every((key) => record(event.usage) && typeof event.usage[key] === "number" && Number.isSafeInteger(event.usage[key]) && event.usage[key] >= 0);
				if (valid) terminal = true;
				else gaps.add("malformed_event");
				continue;
			}
			if (event.type === "thread.started" || event.type === "turn.started" || event.type === "error") {
				if (event.type === "thread.started" && typeof event.thread_id !== "string" ||
					event.type === "error" && typeof event.message !== "string") gaps.add("malformed_event");
				continue;
			}
			if (event.type !== "item.started" && event.type !== "item.completed" && event.type !== "item.updated") {
				gaps.add("unknown_event"); continue;
			}
			const item = event.item;
			if (!record(item) || typeof item.id !== "string" || !item.id || typeof item.type !== "string") {
				gaps.add("malformed_event"); continue;
			}
			const existing = items.get(item.id);
			if (existing && existing.type !== item.type) { gaps.add("conflicting_item"); continue; }
			const state: { type: string; command?: string; started?: string; completed?: string } = existing ?? { type: item.type };
			items.set(item.id, state);
			if (item.type !== "command_execution") {
				if (!["agent_message", "reasoning", "todo_list", "error"].includes(item.type)) gaps.add("unsupported_tool");
				else if ((item.type === "agent_message" || item.type === "reasoning") && typeof item.text !== "string" ||
					item.type === "error" && typeof item.message !== "string" ||
					item.type === "todo_list" && (!Array.isArray(item.items) || item.items.some((entry: unknown) => !record(entry) || typeof entry.text !== "string" || typeof entry.completed !== "boolean"))) gaps.add("malformed_event");
				const phase = event.type === "item.started" ? "started" : "completed";
				const signature = JSON.stringify(item);
				if (event.type !== "item.updated") {
					if (state[phase] !== undefined && state[phase] !== signature) gaps.add("conflicting_item");
					state[phase] = signature;
				}
				continue;
			}
			if (event.type === "item.updated" || typeof item.command !== "string" || typeof item.aggregated_output !== "string" ||
				!(item.exit_code === null || (typeof item.exit_code === "number" && Number.isInteger(item.exit_code) && item.exit_code >= -2147483648 && item.exit_code <= 2147483647)) ||
				!["in_progress", "completed", "failed", "declined"].includes(String(item.status))) {
				gaps.add("malformed_event"); continue;
			}
			if (state.command !== undefined && state.command !== item.command) { gaps.add("conflicting_item"); continue; }
			state.command = item.command;
			const phase = event.type === "item.started" ? "started" : "completed";
			const signature = JSON.stringify(item);
			if (state[phase] !== undefined) {
				if (state[phase] !== signature) gaps.add("conflicting_item");
				continue;
			}
			if (phase === "started") {
				if (state.completed !== undefined || item.status !== "in_progress" || item.exit_code !== null) {
					gaps.add("conflicting_item"); continue;
				}
				state.started = signature;
				receipts.push(Object.freeze({ kind: "command_started", itemId: item.id }));
			} else {
				state.completed = signature;
				const result: Extract<CodexCommandReceipt, { kind: "command_completed" }>["result"] =
					item.status === "declined" && item.exit_code === null ? { kind: "declined" } :
					item.status === "completed" && item.exit_code === 0 ? { kind: "exit_zero" } :
					item.status === "failed" && typeof item.exit_code === "number" && item.exit_code !== 0 ? { kind: "exit_nonzero", exitCode: item.exit_code } : { kind: "unconfirmed" };
				if (result.kind === "unconfirmed") gaps.add("unconfirmed_completion");
				receipts.push(Object.freeze({ kind: "command_completed", itemId: item.id, result: Object.freeze(result) }));
			}
		}
	}
	if (!terminal) gaps.add("missing_terminal");
	for (const state of items.values()) if (state.type === "command_execution" && state.started && !state.completed) gaps.add("unfinished_command");
	return Object.freeze({ status: gaps.size ? "incomplete" : "observed", receipts: Object.freeze(receipts), gaps: Object.freeze([...gaps]) });
}
