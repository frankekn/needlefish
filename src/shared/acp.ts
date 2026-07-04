import {
  runManagedRunnerProcess,
  type ManagedRunnerProcessController,
  type RunnerProcessResult,
} from "./runner-process";

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
}

class AcpProtocolError extends Error {
  readonly name = "AcpProtocolError";
  readonly code = "EACPPROTOCOL";
}

class AcpResponseError extends Error {
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
}

export async function runAcp(invocation: AcpRunnerInvocation): Promise<AcpRunnerResult> {
  const command = process.env.NEEDLEFISH_ACP_BIN?.trim();
  if (!command) throw new Error("NEEDLEFISH_ACP_BIN is required for the acp runner");

  const state: AcpClientState = {
    nextId: 1,
    pending: new Map<number, AcpRequestMethod>(),
    sessionId: null,
    buffer: "",
    text: [],
    completed: false,
  };
  const res = await runManagedRunnerProcess({
    command,
    args: [],
    repoPath: invocation.repoPath,
    timeoutMs: invocation.timeoutMs,
    env: invocation.env,
    onSpawn: (controller) => sendRequest(controller, state, "initialize", initializeParams()),
    onStdout: (chunk, controller) => handleStdout(chunk, controller, state, invocation),
    onTimeout: (controller) => sendCancel(controller, state),
  });

  const out = state.text.join("");
  if (state.completed && res.error === undefined) {
    return { res: { status: 0, signal: null, stdout: res.stdout, stderr: res.stderr }, out };
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
  writeJson(controller, { jsonrpc: "2.0", id, method, params });
}

function sendCancel(controller: ManagedRunnerProcessController, state: AcpClientState): void {
  if (state.sessionId === null) return;
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
    if (error instanceof SyntaxError) throw new AcpProtocolError(`malformed ACP JSON-RPC: ${line.slice(0, 200)}`);
    throw error;
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
      sendRequest(controller, state, "session/new", sessionNewParams(invocation));
      return;
    case "session/new": {
      const sessionId = sessionIdFrom(result);
      state.sessionId = sessionId;
      sendRequest(controller, state, "session/prompt", sessionPromptParams(sessionId, invocation.prompt));
      return;
    }
    case "session/prompt":
      state.completed = true;
      controller.endStdin();
      controller.stop();
      return;
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

function sessionIdFrom(raw: unknown): string {
  if (!isRecord(raw)) throw new AcpProtocolError("acp session/new result must be an object");
  const sessionId = stringField(raw, "sessionId");
  if (sessionId === null) throw new AcpProtocolError("acp session/new result missing sessionId");
  return sessionId;
}

function responseError(method: AcpRequestMethod, raw: unknown): AcpResponseError {
  if (isRecord(raw)) {
    const message = stringField(raw, "message") ?? JSON.stringify(raw);
    return new AcpResponseError(`acp ${method} failed: ${message}`);
  }
  return new AcpResponseError(`acp ${method} failed: ${String(raw)}`);
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
