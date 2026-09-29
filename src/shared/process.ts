import { spawn, spawnSync } from "node:child_process";

export interface RunOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
  /** Keep stdout as-is. `git diff` needs this so a final blank context line survives. */
  readonly preserveOutput?: boolean;
}

export function runText(command: string, args: readonly string[], opts: RunOptions = {}): string {
  const res = spawnSync(command, [...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 1024 * 1024 * 64,
    timeout: opts.timeoutMs,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  const stdout = res.stdout ?? "";
  return opts.preserveOutput ? stdout : stdout.trim();
}

export interface RunAsyncOptions {
  readonly cwd?: string;
  readonly input?: string;
  /** The child is SIGKILLed at this bound; a child that ignores SIGTERM cannot hold the caller. */
  readonly timeoutMs: number;
  /** Aborting SIGKILLs the child; the caller is about to exit and must not orphan it. */
  readonly abortSignal?: AbortSignal;
}

// Same contract as runText, off the event loop. Termination work uses this:
// under the tsx wrapper a blocked loop cannot acknowledge a relayed signal, and
// the wrapper then SIGKILLs the process.
export function runTextAsync(
  command: string,
  args: readonly string[],
  opts: RunAsyncOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd: opts.cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let spawnError: Error | undefined;
    const kill = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.abortSignal?.addEventListener("abort", kill, { once: true });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));
    child.stdin.on("error", () => {});
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      opts.abortSignal?.removeEventListener("abort", kill);
      if (spawnError !== undefined) return reject(spawnError);
      if (timedOut) return reject(new Error(`${command} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
      if (status !== 0) {
        return reject(
          new Error(`${command} ${args.join(" ")} failed: ${signal ?? ""}${stderr.join("").trim()}`),
        );
      }
      resolve(stdout.join("").trim());
    });
    child.stdin.end(opts.input ?? "");
  });
}
