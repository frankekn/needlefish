import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  assertRunnerSchedulingAllowed,
  registerRunnerProcessGroup,
} from "./temp-lifecycle.js";

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

export interface ManagedRunnerProcessController {
  readonly child: ChildProcessWithoutNullStreams;
  writeStdin(chunk: string): void;
  endStdin(): void;
  stop(): void;
}

type RunnerChunkHandler = (chunk: string, controller: ManagedRunnerProcessController) => void;
type RunnerLifecycleHandler = (controller: ManagedRunnerProcessController) => void;

export interface ManagedRunnerProcessInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly repoPath: string;
  readonly timeoutMs: number;
  readonly env: NodeJS.ProcessEnv;
  readonly onSpawn?: RunnerLifecycleHandler;
  readonly onStdout?: RunnerChunkHandler;
  readonly onStderr?: RunnerChunkHandler;
  readonly onTimeout?: RunnerLifecycleHandler;
}

export class RunnerTimeoutError extends Error {
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
  return await runManagedRunnerProcess({
    command: invocation.command,
    args: invocation.args,
    repoPath: invocation.repoPath,
    timeoutMs: invocation.timeoutMs,
    env: invocation.env,
    onSpawn: (controller) => controller.child.stdin.end(invocation.stdin),
  });
}

export async function runManagedRunnerProcess(
  invocation: ManagedRunnerProcessInvocation
): Promise<RunnerProcessResult> {
  assertRunnerSchedulingAllowed();
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
    let cancelTimer: ReturnType<typeof setTimeout> | null = null;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
    let killStarted = false;

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.repoPath,
      env: invocation.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const beginKillSequence = (firstSignal: NodeJS.Signals): void => {
      if (killStarted) return;
      killStarted = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (cancelTimer !== null) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      killRunnerProcessTree(child.pid, firstSignal);
      if (firstSignal === "SIGKILL") {
        giveUpTimer = setTimeout(() => finish(null, "SIGKILL"), runnerSigkillGiveUpMs());
        return;
      }
      hardKillTimer = setTimeout(() => {
        killRunnerProcessTree(child.pid, "SIGKILL");
        giveUpTimer = setTimeout(() => {
          // A setsid-escaped descendant has left this kill group and may keep inherited pipes open.
          // We cannot kill that escapee here; the goal is to stop waiting for child "close".
          finish(null, "SIGKILL");
        }, runnerSigkillGiveUpMs());
      }, runnerTimeoutGraceMs());
    };

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (cancelTimer !== null) clearTimeout(cancelTimer);
      if (hardKillTimer !== null) clearTimeout(hardKillTimer);
      if (giveUpTimer !== null) clearTimeout(giveUpTimer);
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

    const failFromHandler = (error: unknown): void => {
      if (spawnError === undefined && bufferError === undefined) {
        spawnError = error instanceof Error ? error : new Error(String(error));
      }
      beginKillSequence("SIGKILL");
    };

    const controller: ManagedRunnerProcessController = {
      child,
      writeStdin(chunk: string): void {
        try {
          child.stdin.write(chunk);
        } catch (error) {
          failFromHandler(error);
        }
      },
      endStdin(): void {
        child.stdin.end();
      },
      stop(): void {
        beginKillSequence("SIGTERM");
      },
    };
    const unregisterProcessGroup =
      child.pid === undefined
        ? () => {}
        : registerRunnerProcessGroup(
            child.pid,
            beginKillSequence,
            () => killRunnerProcessTree(child.pid, "SIGKILL"),
          );

    const collect = (chunks: string[], bytes: { count: number }, chunk: unknown): string | null => {
      if (bufferError !== undefined) return null;
      const text = String(chunk);
      bytes.count += Buffer.byteLength(text);
      if (bytes.count > RUNNER_MAX_BUFFER_BYTES) {
        bufferError = new RunnerMaxBufferError(invocation.command);
        beginKillSequence("SIGKILL");
        return null;
      }
      chunks.push(text);
      return text;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => {
      const text = collect(stdout, stdoutBytes, chunk);
      if (text === null || invocation.onStdout === undefined) return;
      try {
        invocation.onStdout(text, controller);
      } catch (error) {
        failFromHandler(error);
      }
    });
    child.stderr.on("data", (chunk: unknown) => {
      const text = collect(stderr, stderrBytes, chunk);
      if (text === null || invocation.onStderr === undefined) return;
      try {
        invocation.onStderr(text, controller);
      } catch (error) {
        failFromHandler(error);
      }
    });
    child.stdin.on("error", (error) => {
      if (!timedOut && bufferError === undefined && spawnError === undefined) {
        spawnError = error;
      }
    });
    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.on("close", (status, signal) => {
      unregisterProcessGroup();
      finish(status, signal);
    });

    timer = setTimeout(() => {
      timedOut = true;
      if (invocation.onTimeout !== undefined) {
        try {
          invocation.onTimeout(controller);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
        }
      }
      const cancelBeatMs = invocation.onTimeout === undefined ? 0 : runnerTimeoutCancelMs();
      cancelTimer = setTimeout(() => beginKillSequence("SIGTERM"), cancelBeatMs);
    }, invocation.timeoutMs);

    if (invocation.onSpawn !== undefined) {
      try {
        invocation.onSpawn(controller);
      } catch (error) {
        failFromHandler(error);
      }
    }
  });
}

export function readRunnerDurationMs(value: string | undefined, fallbackMs: number): number {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") return fallbackMs;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

function runnerTimeoutCancelMs(): number {
  return readRunnerDurationMs(process.env.NEEDLEFISH_RUNNER_TIMEOUT_CANCEL_MS, 100);
}

function runnerTimeoutGraceMs(): number {
  return readRunnerDurationMs(process.env.NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS, 5000);
}

function runnerSigkillGiveUpMs(): number {
  return readRunnerDurationMs(process.env.NEEDLEFISH_RUNNER_SIGKILL_GIVE_UP_MS, 2000);
}

function killRunnerProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
