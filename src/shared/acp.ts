import {
  runManagedRunnerProcess,
  type ManagedRunnerProcessController,
  type RunnerProcessResult,
} from "./runner-process.js";
import type { RunUsage } from "./runner.js";

import { RunnerFailure, type RunnerFailureKind } from "./runner-failure.js";

type JsonRecord = Record<string, unknown>;
type JsonRpcId = number | string | null;
type AcpRequestMethod = "initialize" | "session/new" | "session/prompt";

export interface AcpRunnerInvocation {
  readonly prompt: string;
  readonly repoPath: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface AcpRunnerResult {
  readonly res: RunnerProcessResult;
  readonly out: string;
  readonly usage?: RunUsage;
}

class AcpProtocolError extends RunnerFailure {
  constructor(message: string) { super("protocol_error", message); }
  readonly name = "AcpProtocolError";
  readonly code = "EACPPROTOCOL";
}

class AcpResponseError extends RunnerFailure {
  readonly name = "AcpResponseError";
  readonly code = "EACPERROR";
}

interface AcpClientState {
  nextId: number;
  readonly pending: Map<number, AcpRequestMethod>;
  sessionId: string | null;
  buffer: string;
  readonly text: string[];
  completed: boolean;
  usage?: RunUsage;
  cancelled: boolean;
  failure?: RunnerFailure;
  phase: AcpRequestMethod;
}

export async function runAcp(invocation: AcpRunnerInvocation): Promise<AcpRunnerResult> {
  const command = process.env.NEEDLEFISH_ACP_BIN?.trim();
  if (!command) throw new RunnerFailure("startup_failed",
    "NEEDLEFISH_ACP_BIN is required for the acp runner; review not started. Configure the ACP launcher.");
  const initializeTimeoutMs = initializeTimeout(invocation.timeoutMs);
  const startedAt = performance.now();
  let initializeTimer: ReturnType<typeof setTimeout> | undefined;
  const clearInitializeTimer = (): void => {
    clearTimeout(initializeTimer);
    initializeTimer = undefined;
  };

  const state: AcpClientState = {
    nextId: 1,
    pending: new Map<number, AcpRequestMethod>(),
    sessionId: null,
    buffer: "",
    text: [],
    completed: false,
    cancelled: false,
    phase: "initialize",
  };
  let res: RunnerProcessResult;
  try {
    res = await runManagedRunnerProcess({
      command,
      args: [],
      repoPath: invocation.repoPath,
      timeoutMs: invocation.timeoutMs,
      env: invocation.env,
      onSpawn: (controller) => {
        sendRequest(controller, state, "initialize", initializeParams());
        initializeTimer = setTimeout(() => {
          if (state.phase !== "initialize" || state.failure) return;
          state.failure = new RunnerFailure("startup_timeout", "initialize timeout");
          controller.stop();
        }, initializeTimeoutMs);
      },
      onStdout: (chunk, controller) => {
        try {
          handleStdout(chunk, controller, state, invocation);
        } catch (error) {
          if (state.phase !== "session/prompt" && !state.failure) {
            state.failure = state.phase === "initialize"
              ? new RunnerFailure("startup_failed", startupCause(error))
              : error instanceof RunnerFailure ? error
              : new RunnerFailure("unknown", startupCause(error), true);
          }
          throw error;
        } finally {
          // Noise and partial JSON never extend or satisfy the handshake deadline.
          if (state.phase !== "initialize" || state.failure) clearInitializeTimer();
        }
      },
      onTimeout: (controller) => {
        if (!state.failure) {
          state.failure = state.phase === "session/prompt"
            ? new RunnerFailure("unknown", "ACP session/prompt review timeout (ETIMEDOUT); review not completed; raw streams withheld", true)
            : new RunnerFailure(state.phase === "initialize" ? "startup_timeout" : "unknown",
                `${state.phase} timeout`, state.phase !== "initialize");
        }
        sendCancel(controller, state);
      },
    });
  } finally {
    clearInitializeTimer();
  }

  if (state.phase !== "session/prompt") {
    const failure = state.failure ?? (res.error === undefined && res.status === 0
      ? new AcpProtocolError("acp runner exited before session/prompt completed") : undefined);
    // Stage is diagnostic metadata, not permission to discard session/new's
    // existing error classification or bounded retry policy.
    const kind = state.phase === "initialize"
      ? failure?.kind === "startup_timeout" ? "startup_timeout" : "startup_failed"
      : failure?.kind ?? "unknown";
    const retryable = state.phase === "initialize" ? false : failure?.retryable ?? true;
    const reason = failure?.message ?? (res.error ? startupCause(res.error) : "agent exited before startup completed");
    const elapsed = Math.round(performance.now() - startedAt);
    const streams = `stdout=${Buffer.byteLength(res.stdout)}B; stderr=${Buffer.byteLength(res.stderr)}B (raw text withheld)`;
    return {
      res: { ...res, error: new RunnerFailure(kind,
        `ACP ${state.phase} failed: ${reason}; elapsed=${elapsed}ms; exit=${res.status ?? "none"}; signal=${res.signal ?? "none"}; ${streams}. Review not started; check launcher, login and agent configuration.`, retryable) },
      out: state.text.join(""),
    };
  }

  const out = state.text.join("");
  // A failure is sticky, even if the agent emits end_turn or
  // valid review JSON in the same chunk, during cancellation, or before exit.
  if (state.failure) return { res: { ...res, error: state.failure }, out };
  if (state.completed && res.error === undefined) {
    return {
      res: { status: 0, signal: null, stdout: res.stdout, stderr: res.stderr },
      out,
      ...(state.usage ? { usage: state.usage } : {}),
    };
  }
  if (res.error !== undefined) return { res, out };
  if (res.status !== 0) return { res, out };
  return {
    res: {
      ...res,
      error: new AcpProtocolError("acp runner exited before session/prompt completed"),
    },
    out,
  };
}

// This is a protocol-startup budget, not a shorter model review timeout.
function initializeTimeout(totalTimeoutMs: number): number {
  const raw = process.env.NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS?.trim();
  const configured = raw ? Number(raw) : 30_000;
  if (!Number.isSafeInteger(configured) || configured <= 0 || configured > 2_147_483_647) {
    throw new RunnerFailure("startup_failed",
      "NEEDLEFISH_ACP_INITIALIZE_TIMEOUT_MS must be an integer from 1 to 2147483647; review not started");
  }
  return Math.min(configured, totalTimeoutMs);
}

// Public diagnostics never interpolate agent text, stderr, command arguments,
// or raw error messages. Before initialize, logs may still contain credentials.
function startupCause(error: unknown): string {
  // Protocol parser messages are adapter-authored and already omit raw input.
  if (error instanceof AcpProtocolError) return error.message;
  if (error instanceof RunnerFailure) {
    if (error.kind === "auth_required") return "authentication required";
    if (error.kind === "cancelled") return "agent cancelled startup";
    if (error.kind === "protocol_error") return "invalid or incompatible ACP response";
    return "agent reported a startup error";
  }
  const code: unknown = error instanceof Error
    ? Object.getOwnPropertyDescriptor(error, "code")?.value : undefined;
  if (typeof code === "string" && ["ENOENT", "EACCES", "ENOEXEC", "EPIPE", "ENOBUFS"].includes(code)) {
    return `launcher/process error (${code})`;
  }
  return "launcher/process failure";
}

function initializeParams(): JsonRecord {
  return {
    protocolVersion: 1,
    clientCapabilities: {},
  };
}

function sessionNewParams(invocation: AcpRunnerInvocation): JsonRecord {
  return {
    cwd: invocation.repoPath,
    mcpServers: [],
  };
}

function sessionPromptParams(sessionId: string, prompt: string): JsonRecord {
  return {
    sessionId,
    prompt: [
      {
        type: "text",
        text: prompt,
      },
    ],
  };
}

function sendRequest(
  controller: ManagedRunnerProcessController,
  state: AcpClientState,
  method: AcpRequestMethod,
  params: JsonRecord
): void {
  const id = state.nextId;
  state.nextId += 1;
  state.pending.set(id, method);
  state.phase = method;
  writeJson(controller, { jsonrpc: "2.0", id, method, params });
}

function sendCancel(controller: ManagedRunnerProcessController, state: AcpClientState): void {
  if (state.sessionId === null || state.cancelled) return;
  state.cancelled = true;
  writeJson(controller, {
    jsonrpc: "2.0",
    method: "session/cancel",
    params: { sessionId: state.sessionId },
  });
}

function handleStdout(
  chunk: string,
  controller: ManagedRunnerProcessController,
  state: AcpClientState,
  invocation: AcpRunnerInvocation
): void {
  state.buffer += chunk;
  for (;;) {
    const newline = state.buffer.indexOf("\n");
    if (newline === -1) return;
    const line = state.buffer.slice(0, newline).trim();
    state.buffer = state.buffer.slice(newline + 1);
    if (!line) continue;
    handleLine(line, controller, state, invocation);
  }
}

function handleLine(
  line: string,
  controller: ManagedRunnerProcessController,
  state: AcpClientState,
  invocation: AcpRunnerInvocation
): void {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch (error) {
    if (state.failure) return;
    if (error instanceof SyntaxError) throw new AcpProtocolError("malformed ACP JSON-RPC; raw text withheld");
    throw error;
  }
  if (state.failure) {
    // Still answer pending permission requests while the process group stops.
    // Other late output remains in the raw transcript, never usable output.
    if (isRecord(message) && message.method === "session/request_permission") {
      const id = rpcId(message.id);
      if (id !== undefined) cancelPermission(controller, id);
    }
    return;
  }
  if (!isRecord(message)) throw new AcpProtocolError("ACP JSON-RPC message must be an object");
  const method = stringField(message, "method");
  if (method !== null) {
    handleMethodMessage(method, message, controller, state);
    return;
  }
  handleResponseMessage(message, controller, state, invocation);
}

function handleMethodMessage(
  method: string,
  message: JsonRecord,
  controller: ManagedRunnerProcessController,
  state: AcpClientState
): void {
  if (method === "session/request_permission") {
    const id = rpcId(message.id);
    if (id === undefined) throw new AcpProtocolError("ACP permission request missing a valid id");
    if (state.sessionId === null || !isRecord(message.params) || message.params.sessionId !== state.sessionId) {
      throw new AcpProtocolError("ACP permission request has no active matching session");
    }
    state.failure = new RunnerFailure("permission_required",
      "ACP agent requested interactive permission. Needlefish cancelled this run without granting permission; check the agent launch configuration and organization ask/deny policy.");
    cancelPermission(controller, id);
    sendCancel(controller, state);
    controller.stop();
    return;
  }
  if (method === "session/update") {
    collectSessionUpdate(message.params, state);
    return;
  }
  const id = rpcId(message.id);
  if (id === undefined) return;
  writeJson(controller, {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32001,
      message: `Needlefish denied ACP agent request: ${method}`,
    },
  });
}

function handleResponseMessage(
  message: JsonRecord,
  controller: ManagedRunnerProcessController,
  state: AcpClientState,
  invocation: AcpRunnerInvocation
): void {
  if (typeof message.id !== "number") throw new AcpProtocolError("ACP response id must be numeric");
  const method = state.pending.get(message.id);
  if (method === undefined) throw new AcpProtocolError(`unexpected ACP response id: ${message.id}`);
  state.pending.delete(message.id);
  if (message.error !== undefined) throw responseError(method, message.error);
  const result = message.result;
  switch (method) {
    case "initialize":
      if (message.jsonrpc !== "2.0" || !isRecord(result) || result.protocolVersion !== 1) {
        throw new AcpProtocolError("ACP initialize requires a compatible protocolVersion 1 result");
      }
      sendRequest(controller, state, "session/new", sessionNewParams(invocation));
      return;
    case "session/new": {
      const sessionId = sessionIdFrom(result);
      state.sessionId = sessionId;
      sendRequest(controller, state, "session/prompt", sessionPromptParams(sessionId, invocation.prompt));
      return;
    }
    case "session/prompt": {
      assertCompletedTurn(result);
      const usage = promptUsageFrom(result);
      if (usage) state.usage = usage;
      state.completed = true;
      controller.endStdin();
      controller.stop();
      return;
    }
  }
}

function collectSessionUpdate(params: unknown, state: AcpClientState): void {
  if (!isRecord(params)) return;
  const update = isRecord(params.update) ? params.update : params;
  const updateKind = stringField(update, "sessionUpdate") ?? stringField(update, "kind");
  if (updateKind !== null && updateKind !== "agent_message_chunk") return;
  const content = update.content;
  if (isRecord(content)) {
    const text = stringField(content, "text");
    if (text !== null) state.text.push(text);
    return;
  }
  const text = stringField(update, "text");
  if (text !== null) state.text.push(text);
}

function promptUsageFrom(raw: unknown): RunUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.usage)) return undefined;
  const { totalTokens, inputTokens, outputTokens } = raw.usage;
  if (!isNonnegativeSafeInteger(totalTokens) || !isNonnegativeSafeInteger(inputTokens) ||
      !isNonnegativeSafeInteger(outputTokens) || totalTokens < inputTokens + outputTokens) {
    return undefined;
  }
  return { totalTokens, inputTokens, outputTokens };
}

function isNonnegativeSafeInteger(raw: unknown): raw is number {
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0;
}

function sessionIdFrom(raw: unknown): string {
  if (!isRecord(raw)) throw new AcpProtocolError("acp session/new result must be an object");
  const sessionId = stringField(raw, "sessionId");
  if (sessionId === null) throw new AcpProtocolError("acp session/new result missing sessionId");
  return sessionId;
}

// Protocol codes, not the untrusted message/data text, determine failure kind.
// https://agentclientprotocol.com/protocol/v1/schema#errorcode
function responseError(method: AcpRequestMethod, raw: unknown): RunnerFailure {
  if (!isRecord(raw) || typeof raw.code !== "number" || !Number.isInteger(raw.code) ||
      raw.code < -2147483648 || raw.code > 2147483647 || typeof raw.message !== "string") {
    return new AcpProtocolError(`acp ${method} returned a malformed error; raw text withheld`);
  }
  if (raw.code === -32000) {
    return new AcpResponseError("auth_required", `acp ${method} failed: authentication required; sign in using the agent's official CLI`);
  }
  if (raw.code === -32800) {
    return new AcpResponseError("cancelled", `acp ${method} failed: request cancelled`);
  }
  if ([-32700, -32600, -32601, -32602].includes(raw.code)) {
    return new AcpResponseError("protocol_error", `acp ${method} failed (JSON-RPC ${raw.code}); check agent protocol and launch compatibility`);
  }
  // Unknown/server errors retain the existing bounded retry policy. No ACP
  // standard code proves subscription quota exhaustion or permits fallback.
  return new AcpResponseError("unknown", `acp ${method} failed (JSON-RPC ${raw.code}); agent error text withheld`, true);
}

function assertCompletedTurn(raw: unknown): void {
  const reason = isRecord(raw) ? raw.stopReason : undefined;
  if (reason === "end_turn") return;
  const kinds: Readonly<Record<string, RunnerFailureKind>> = {
    cancelled: "cancelled",
    refusal: "refused",
    max_tokens: "response_limit",
    max_turn_requests: "response_limit",
  };
  if (typeof reason !== "string" || !Object.hasOwn(kinds, reason)) {
    throw new AcpProtocolError("acp session/prompt requires a recognized stopReason; review not completed");
  }
  throw new RunnerFailure(kinds[reason], `acp session/prompt stopped with ${reason}; review not completed`);
}

function cancelPermission(controller: ManagedRunnerProcessController, id: JsonRpcId): void {
  writeJson(controller, { jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
}

function writeJson(controller: ManagedRunnerProcessController, message: JsonRecord): void {
  controller.writeStdin(`${JSON.stringify(message)}\n`);
}

function stringField(record: JsonRecord, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function rpcId(raw: unknown): JsonRpcId | undefined {
  if (typeof raw === "number" || typeof raw === "string" || raw === null) return raw;
  return undefined;
}

function isRecord(raw: unknown): raw is JsonRecord {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}