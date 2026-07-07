import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAcp } from "./acp.js";
import {
  parsePositiveInteger,
  type RunnerName,
  type RunnerOptions,
  type RunStat,
} from "./runner.js";
import { resolveRunner } from "./runner-detection.js";
import { spawnRunnerProcess, type RunnerProcessResult } from "./runner-process.js";
import {
  assertRunnerSandboxClean,
  isRunnerSafetyError,
  prepareRunnerSandbox,
} from "./runner-sandbox.js";

export { isRunnerSafetyError } from "./runner-sandbox.js";

const BASE_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
] as const;

const RUNNER_ENV_ALLOWLIST: Record<RunnerName, readonly string[]> = {
  codex: ["CODEX_BIN", "CODEX_MODEL", "CODEX_REASONING_EFFORT", "CODEX_RETRY_MS", "CODEX_TIMEOUT_MS"],
  claude: ["CLAUDE_BIN", "CLAUDE_MODEL"],
  opencode: ["OPENCODE_BIN", "OPENCODE_MODEL"],
  grok: ["GROK_BIN", "GROK_MODEL"],
  openai: [],
  acp: ["NEEDLEFISH_ACP_BIN"],
};

function buildRunnerEnv(runner: RunnerName, ghConfigDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GH_CONFIG_DIR: ghConfigDir };
  const allowed = [...BASE_ENV_ALLOWLIST, ...RUNNER_ENV_ALLOWLIST[runner]];
  const extra = (process.env.NEEDLEFISH_RUNNER_ENV_PASSTHROUGH ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of [...allowed, ...extra]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export interface CodexOptions extends RunnerOptions {
  readonly repoPath: string;
  readonly targetHeadSha: string;
  readonly targetPatch?: string;
  readonly label?: string;
  readonly onStat?: (stat: RunStat) => void;
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
  readonly reasoningEffort: string | undefined;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly tmp: string;
}

export async function runCodex(prompt: string, opts: CodexOptions): Promise<string> {
  const runner = resolveRunner(opts);
  const maxAttempts = process.env.NEEDLEFISH_NO_RETRY ? 1 : 2;
  const startedAt = Date.now();
  let attempts = 0;
  const emitStat = (ok: boolean): void => {
    if (!opts.onStat) return;
    const model = resolveModel(opts, runner);
    opts.onStat({
      label: opts.label ?? "(unlabeled)",
      runner,
      ...(model !== undefined ? { model } : {}),
      durationMs: Date.now() - startedAt,
      attempts,
      ok,
    });
  };
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      const out = await runCodexOnce(prompt, opts, runner);
      emitStat(true);
      return out;
    } catch (err) {
      if (!(err instanceof Error) || isRunnerSafetyError(err)) {
        emitStat(false);
        throw err;
      }
      lastErr = err;
      if (attempt < maxAttempts) {
        const backoff = retryMsFor(runner);
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  emitStat(false);
  throw lastErr;
}

async function runCodexOnce(prompt: string, opts: CodexOptions, runner: RunnerName): Promise<string> {
  const model = resolveModel(opts, runner);
  const timeoutMs = opts.timeoutMs ?? timeoutMsFor(runner);
  if (runner === "openai") {
    return runOpenAIDirect(prompt, model, timeoutMs);
  }
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
      ...(opts.targetPatch ? { targetPatch: opts.targetPatch } : {}),
      tmp,
    });
    const invocation = {
      prompt: sandbox.prompt,
      repoPath: sandbox.repoPath,
      model,
      reasoningEffort: opts.reasoningEffort,
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
    assertRunnerSandboxClean(runner, sandbox.repoPath, sandbox.expectedHeadSha);
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
    case "openai":
      return process.env.OPENAI_MODEL;
    case "grok":
      return process.env.GROK_MODEL;
    case "acp":
      return undefined;
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
    case "openai":
      throw new Error("openai runner uses direct HTTP path, not runRunner");
    case "grok":
      return await runGrok(invocation);
    case "acp":
      return await runAcp(invocation);
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
  if (invocation.reasoningEffort) args.push("-c", `model_reasoning_effort=${invocation.reasoningEffort}`);

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
  if (value === undefined || value === "") return "medium";
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
  if (invocation.reasoningEffort) args.push("--effort", invocation.reasoningEffort);

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
  if (invocation.reasoningEffort) args.push("--variant", invocation.reasoningEffort);
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

async function runGrok(invocation: RunnerInvocation): Promise<RunnerResult> {
  const promptPath = path.join(invocation.tmp, "prompt.txt");
  writeFileSync(promptPath, invocation.prompt, { mode: 0o600 });
  const args = ["-m", invocation.model ?? "grok-build", "--prompt-file", promptPath, "--output-format", "plain"];
  if (invocation.reasoningEffort) args.push("--reasoning-effort", invocation.reasoningEffort);
  const res = await spawnRunnerProcess({
    command: process.env.GROK_BIN ?? "grok",
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
    case "openai":
      return result.out;
    case "grok":
      return result.out;
    case "acp":
      return result.out;
  }
}

async function runOpenAIDirect(prompt: string, model: string | undefined, timeoutMs: number): Promise<string> {
  const baseUrl = (process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for the openai runner");
  if (!model) throw new Error("model is required for the openai runner (use --model or OPENAI_MODEL)");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }] }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`openai runner HTTP ${res.status}: ${text.slice(0, 2000)}`);
    const json = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content) {
      throw new Error(`openai runner: empty content in response: ${text.slice(0, 500)}`);
    }
    return content;
  } finally {
    clearTimeout(timer);
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
