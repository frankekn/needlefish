import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parsePositiveInteger,
  parseRunnerName,
  type RunnerName,
  type RunnerOptions,
} from "./runner";
import { spawnRunnerProcess, type RunnerProcessResult } from "./runner-process";
import {
  assertRunnerSandboxClean,
  isRunnerSafetyError,
  prepareRunnerSandbox,
} from "./runner-sandbox";

export { isRunnerSafetyError } from "./runner-sandbox";

export interface CodexOptions extends RunnerOptions {
  readonly repoPath: string;
  readonly targetHeadSha: string;
}

type JsonRecord = Record<string, unknown>;
type CodexReasoningEffort = "medium" | "high" | "xhigh";

interface RunnerResult {
  readonly res: RunnerProcessResult;
  readonly out: string;
}

interface RunnerInvocation {
  readonly prompt: string;
  readonly repoPath: string;
  readonly model: string | undefined;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly tmp: string;
}

export async function runCodex(prompt: string, opts: CodexOptions): Promise<string> {
  const runner = resolveRunner(opts);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return await runCodexOnce(prompt, opts, runner);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      if (isRunnerSafetyError(err)) throw err;
      lastErr = err;
      if (attempt < 2) {
        const backoff = retryMsFor(runner);
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastErr;
}

async function runCodexOnce(prompt: string, opts: CodexOptions, runner: RunnerName): Promise<string> {
  const model = resolveModel(opts, runner);
  const timeoutMs = opts.timeoutMs ?? timeoutMsFor(runner);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-"));
  const ghConfigDir = path.join(tmp, "gh-empty");
  mkdirSync(ghConfigDir, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: ghConfigDir };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_API_TOKEN;

  try {
    const sandbox = prepareRunnerSandbox({
      runner,
      repoPath: opts.repoPath,
      prompt,
      targetHeadSha: opts.targetHeadSha,
      tmp,
    });
    const invocation = {
      prompt: sandbox.prompt,
      repoPath: sandbox.repoPath,
      model,
      timeoutMs,
      env,
      tmp,
    };
    const result = await runRunner(runner, invocation);

    if (result.res.error) throw result.res.error;
    if (result.res.status !== 0) {
      throw new Error(
        `${runner} runner exited ${result.res.status}: ${(result.res.stderr ?? "").slice(0, 2000)}`
      );
    }
    assertRunnerSandboxClean(runner, sandbox.repoPath, opts.targetHeadSha);
    return outputFor(runner, result);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found in codex output");
  }
  return JSON.parse(raw.slice(start, end + 1));
}

function resolveRunner(opts: CodexOptions): RunnerName {
  if (opts.runner) return opts.runner;
  const envRunner = process.env.NEEDLEFISH_RUNNER;
  return envRunner ? parseRunnerName(envRunner, "NEEDLEFISH_RUNNER") : "codex";
}

function resolveModel(opts: CodexOptions, runner: RunnerName): string | undefined {
  if (opts.model) return opts.model;
  if (process.env.NEEDLEFISH_MODEL) return process.env.NEEDLEFISH_MODEL;
  switch (runner) {
    case "codex":
      return process.env.CODEX_MODEL;
    case "claude":
      return process.env.CLAUDE_MODEL;
    case "opencode":
      return process.env.OPENCODE_MODEL;
  }
}

function timeoutMsFor(runner: RunnerName): number {
  if (process.env.NEEDLEFISH_TIMEOUT_MS !== undefined) {
    return parsePositiveInteger(process.env.NEEDLEFISH_TIMEOUT_MS, "NEEDLEFISH_TIMEOUT_MS");
  }
  if (runner === "codex" && process.env.CODEX_TIMEOUT_MS !== undefined) {
    return parsePositiveInteger(process.env.CODEX_TIMEOUT_MS, "CODEX_TIMEOUT_MS");
  }
  return 600000;
}

function retryMsFor(runner: RunnerName): number {
  if (process.env.NEEDLEFISH_RETRY_MS !== undefined) {
    return parsePositiveInteger(process.env.NEEDLEFISH_RETRY_MS, "NEEDLEFISH_RETRY_MS");
  }
  if (runner === "codex" && process.env.CODEX_RETRY_MS !== undefined) {
    return parsePositiveInteger(process.env.CODEX_RETRY_MS, "CODEX_RETRY_MS");
  }
  return 5000;
}

async function runRunner(runner: RunnerName, invocation: RunnerInvocation): Promise<RunnerResult> {
  switch (runner) {
    case "codex":
      return await runCodexCli(invocation);
    case "claude":
      return await runClaude(invocation);
    case "opencode":
      return await runOpenCode(invocation);
  }
}

async function runCodexCli(invocation: RunnerInvocation): Promise<RunnerResult> {
  const lastMsg = path.join(invocation.tmp, "last.txt");
  const reasoningEffort = resolveCodexReasoningEffort();
  const args = [
    "exec",
    "--color",
    "never",
    "--ignore-user-config",
    "-c",
    `model_reasoning_effort="${reasoningEffort}"`,
    "-s",
    "read-only",
    "--skip-git-repo-check",
    "--output-last-message",
    lastMsg,
  ];
  if (invocation.model) args.push("-m", invocation.model);

  const res = await spawnRunnerProcess({
    command: process.env.CODEX_BIN ?? "codex",
    args,
    stdin: invocation.prompt,
    repoPath: invocation.repoPath,
    timeoutMs: invocation.timeoutMs,
    env: invocation.env,
  });

  let out = "";
  try {
    out = readFileSync(lastMsg, "utf8");
  } catch {
    out = res.stdout ?? "";
  }
  return { res, out };
}

function resolveCodexReasoningEffort(): CodexReasoningEffort {
  const value = process.env.CODEX_REASONING_EFFORT;
  if (value === undefined || value === "") return "high";
  if (value === "medium" || value === "high" || value === "xhigh") return value;
  throw new Error("CODEX_REASONING_EFFORT must be one of: medium, high, xhigh");
}

async function runClaude(invocation: RunnerInvocation): Promise<RunnerResult> {
  const args = [
    "--print",
    "--output-format",
    "text",
    "--permission-mode",
    "plan",
    "--safe-mode",
    "--no-session-persistence",
  ];
  if (invocation.model) args.push("--model", invocation.model);

  const res = await spawnRunnerProcess({
    command: process.env.CLAUDE_BIN ?? "claude",
    args,
    stdin: invocation.prompt,
    repoPath: invocation.repoPath,
    timeoutMs: invocation.timeoutMs,
    env: invocation.env,
  });
  return { res, out: res.stdout ?? "" };
}

async function runOpenCode(invocation: RunnerInvocation): Promise<RunnerResult> {
  const promptPath = path.join(invocation.tmp, "prompt.md");
  writeFileSync(promptPath, invocation.prompt, { mode: 0o600 });
  const args = ["run", "--format", "json", "--pure", "--dir", invocation.repoPath];
  args.push("--file", promptPath);
  if (invocation.model) args.push("--model", invocation.model);
  args.push("Use the attached prompt file as your complete instruction.");

  const res = await spawnRunnerProcess({
    command: process.env.OPENCODE_BIN ?? "opencode",
    args,
    stdin: "",
    repoPath: invocation.repoPath,
    timeoutMs: invocation.timeoutMs,
    env: invocation.env,
  });
  return { res, out: res.stdout ?? "" };
}

function outputFor(runner: RunnerName, result: RunnerResult): string {
  switch (runner) {
    case "codex":
    case "claude":
      return result.out;
    case "opencode":
      return extractOpenCodeText(result.out);
  }
}

function isRecord(raw: unknown): raw is JsonRecord {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function openCodeText(raw: JsonRecord): string | null {
  const direct = raw.text;
  if (typeof direct === "string") return direct;
  const part = raw.part;
  if (!isRecord(part)) return null;
  const nested = part.text;
  return typeof nested === "string" ? nested : null;
}

function extractOpenCodeText(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    if (!isRecord(raw)) continue;
    const text = openCodeText(raw);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("") : stdout;
}
