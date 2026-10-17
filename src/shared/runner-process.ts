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
  readonly idleTimeoutMs?: number;
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
  readonly idleTimeoutMs?: number;
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

export class RunnerIdleTimeoutError extends Error {
  readonly code = "EIDLETIMEDOUT";

  constructor(command: string) {
    super(`spawn ${command} EIDLETIMEDOUT`);
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
    ...(invocation.idleTimeoutMs === undefined
      ? {}
      : { idleTimeoutMs: invocation.idleTimeoutMs }),
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
    let spawnError: Error | undefined;
    let stdinError: Error | undefined;
    let bufferError: Error | undefined;
    let timeoutError: Error | undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelTimer: ReturnType<typeof setTimeout> | null = null;
    let hardKillTimer: ReturnType<typeof setTimeout> | null = null;
    let giveUpTimer: ReturnType<typeof setTimeout> | null = null;
    let killStarted = false;
    let processGroupReleased = false;

    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.repoPath,
      env: invocation.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const childClosed = new Promise<void>((resolve) => child.once("close", () => resolve()));

    const forceKillSequence = (): void => {
      if (settled || giveUpTimer !== null) return;
      killStarted = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (cancelTimer !== null) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      if (hardKillTimer !== null) {
        clearTimeout(hardKillTimer);
        hardKillTimer = null;
      }
      if (!processGroupReleased) processGroupReleased = !signalRunnerProcessTree(child, "SIGKILL");
      // Escaped descendants may still hold pipes after the owned group is gone.
      giveUpTimer = setTimeout(() => finish(null, "SIGKILL"), runnerSigkillGiveUpMs());
    };

    const beginKillSequence = (firstSignal: NodeJS.Signals): void => {
      if (killStarted) return;
      if (firstSignal === "SIGKILL") {
        forceKillSequence();
        return;
      }
      killStarted = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (cancelTimer !== null) {
        clearTimeout(cancelTimer);
        cancelTimer = null;
      }
      if (!processGroupReleased) processGroupReleased = !signalRunnerProcessTree(child, firstSignal);
      hardKillTimer = setTimeout(forceKillSequence, runnerTimeoutGraceMs());
    };

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (idleTimer !== null) clearTimeout(idleTimer);
      if (cancelTimer !== null) clearTimeout(cancelTimer);
      if (hardKillTimer !== null) clearTimeout(hardKillTimer);
      if (giveUpTimer !== null) clearTimeout(giveUpTimer);
      const error = spawnError ?? bufferError ?? timeoutError;
      // A stdin error only says the child stopped reading. When the child then
      // exited nonzero on its own, its exit status and stderr are the diagnosis;
      // An interrupted run or a zero exit keeps the original error precedence.
      const explainedByExit = stdinError !== undefined && error === stdinError
        && status !== null && status !== 0 && signal === null
        && !killStarted && bufferError === undefined && timeoutError === undefined;
      resolve({
        status,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        error: explainedByExit ? undefined : error,
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
            invocation.repoPath,
            beginKillSequence,
            forceKillSequence,
            childClosed,
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

    const beginTimeout = (error: RunnerTimeoutError | RunnerIdleTimeoutError): void => {
      if (settled || timeoutError !== undefined) return;
      timeoutError = error;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (idleTimer !== null) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (invocation.onTimeout !== undefined) {
        try {
          invocation.onTimeout(controller);
        } catch (handlerError) {
          if (!(handlerError instanceof Error)) throw handlerError;
        }
      }
      const cancelBeatMs = invocation.onTimeout === undefined ? 0 : runnerTimeoutCancelMs();
      cancelTimer = setTimeout(() => beginKillSequence("SIGTERM"), cancelBeatMs);
    };

    const refreshIdleTimer = (): void => {
      if (invocation.idleTimeoutMs === undefined || timeoutError !== undefined) return;
      if (idleTimer !== null) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => beginTimeout(new RunnerIdleTimeoutError(invocation.command)),
        invocation.idleTimeoutMs,
      );
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: unknown) => {
      const text = collect(stdout, stdoutBytes, chunk);
      if (text !== null) refreshIdleTimer();
      if (text === null || invocation.onStdout === undefined) return;
      try {
        invocation.onStdout(text, controller);
      } catch (error) {
        failFromHandler(error);
      }
    });
    child.stderr.on("data", (chunk: unknown) => {
      const text = collect(stderr, stderrBytes, chunk);
      if (text !== null) refreshIdleTimer();
      if (text === null || invocation.onStderr === undefined) return;
      try {
        invocation.onStderr(text, controller);
      } catch (error) {
        failFromHandler(error);
      }
    });
    child.stdin.on("error", (error) => {
      if (timeoutError === undefined && bufferError === undefined && spawnError === undefined) {
        spawnError = error;
        stdinError = error;
      }
    });
    child.on("error", (error) => {
      spawnError = error;
      finish(null, null);
    });
    child.once("exit", () => {
      if (killStarted) {
        forceKillSequence();
        processGroupReleased = true;
      } else {
        processGroupReleased = !signalRunnerProcessTree(child, 0);
      }
    });
    child.on("close", (status, signal) => {
      if (!processGroupReleased) signalRunnerProcessTree(child, "SIGKILL");
      processGroupReleased = true;
      unregisterProcessGroup();
      finish(status, signal);
    });

    timer = setTimeout(
      () => beginTimeout(new RunnerTimeoutError(invocation.command)),
      invocation.timeoutMs,
    );
    refreshIdleTimer();

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

function signalRunnerProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals | 0): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  const leaderExited = child.exitCode !== null || child.signalCode !== null;
  if (process.platform === "win32") {
    if (leaderExited) return false;
    if (signal === 0) return true;
    const args = ["/pid", String(pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    spawnSync("taskkill", args, { stdio: "ignore" });
    return true;
  }
  if (leaderExited) {
    try {
      process.kill(pid, 0);
      // A live PID after leader exit belongs to a different process.
      return false;
    } catch (error) {
      if (!isGoneProcessError(error)) throw error;
      if (error.code !== "ESRCH") return false;
    }
  }
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (!isGoneProcessError(error)) throw error;
    return false;
  }
}

function isGoneProcessError(error: unknown): error is Error & { code: "ESRCH" | "EPERM" } {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "EPERM")
  );
}
