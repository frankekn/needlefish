import { spawn, spawnSync } from "node:child_process";

const RUNNER_TIMEOUT_KILL_SIGNAL: NodeJS.Signals = "SIGKILL";
const RUNNER_MAX_BUFFER_BYTES = 1024 * 1024 * 64;

export interface RunnerProcessResult {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: Error;
}

export interface RunnerProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly repoPath: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
}

class RunnerTimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(command: string) {
    super(`spawn ${command} ETIMEDOUT`);
  }
}

class RunnerMaxBufferError extends Error {
  readonly code = "ENOBUFS";

  constructor(command: string) {
    super(`spawn ${command} ENOBUFS`);
  }
}

export async function spawnRunnerProcess(
  invocation: RunnerProcessInvocation
): Promise<RunnerProcessResult> {
  return await new Promise<RunnerProcessResult>((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const stdoutBytes = { count: 0 };
    const stderrBytes = { count: 0 };
    let settled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let bufferError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.repoPath,
      env: invocation.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve({
        status,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        error:
          spawnError ??
          bufferError ??
          (timedOut ? new RunnerTimeoutError(invocation.command) : undefined),
      });
    };

    const collect = (chunks: string[], bytes: { count: number }, chunk: unknown): void => {
      if (bufferError !== undefined) return;
      const text = String(chunk);
      bytes.count += Buffer.byteLength(text);
      if (bytes.count > RUNNER_MAX_BUFFER_BYTES) {
        bufferError = new RunnerMaxBufferError(invocation.command);
        killRunnerProcessTree(child.pid);
        return;
      }
      chunks.push(text);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => collect(stdout, stdoutBytes, chunk));
    child.stderr.on("data", (chunk: unknown) => collect(stderr, stderrBytes, chunk));
    child.stdin.on("error", (error) => {
      if (!timedOut && bufferError === undefined && spawnError === undefined) {
        spawnError = error;
      }
    });
    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (status, signal) => finish(status, signal));

    timer = setTimeout(() => {
      timedOut = true;
      killRunnerProcessTree(child.pid);
    }, invocation.timeoutMs);

    child.stdin.end(invocation.stdin);
  });
}

function killRunnerProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, RUNNER_TIMEOUT_KILL_SIGNAL);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
