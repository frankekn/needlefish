import { spawnSync } from "node:child_process";
import path from "node:path";
import type { RunnerName } from "./runner";

export interface RunnerSandbox {
  readonly repoPath: string;
  readonly prompt: string;
}

export interface RunnerSandboxOptions {
  readonly runner: RunnerName;
  readonly repoPath: string;
  readonly prompt: string;
  readonly targetHeadSha: string;
  readonly tmp: string;
}

class RunnerWorktreeChangedError extends Error {
  readonly name = "RunnerWorktreeChangedError";

  constructor(runner: RunnerName, detail?: string) {
    super(
      detail
        ? `${runner} runner changed the review sandbox worktree: ${detail}`
        : `${runner} runner changed the review sandbox worktree`
    );
  }
}

export function isRunnerSafetyError(error: unknown): boolean {
  return error instanceof RunnerWorktreeChangedError;
}

export function prepareRunnerSandbox(options: RunnerSandboxOptions): RunnerSandbox {
  const sandboxPath = path.join(options.tmp, "runner-repo");
  git(["clone", "--quiet", "--no-hardlinks", options.repoPath, sandboxPath], options.repoPath);
  git(["checkout", "--quiet", "--detach", options.targetHeadSha], sandboxPath);
  return {
    repoPath: sandboxPath,
    prompt: options.prompt.split(options.repoPath).join(sandboxPath),
  };
}

export function assertRunnerSandboxClean(
  runner: RunnerName,
  repoPath: string,
  expectedHeadSha: string
): void {
  let currentHead: string;
  let status: string;
  try {
    currentHead = git(["rev-parse", "HEAD"], repoPath);
    status = gitStatus(repoPath);
  } catch (error) {
    if (error instanceof Error) {
      throw new RunnerWorktreeChangedError(runner, error.message);
    }
    throw error;
  }
  if (currentHead !== expectedHeadSha) {
    throw new RunnerWorktreeChangedError(runner, `HEAD moved to ${currentHead}`);
  }
  if (status.trim()) {
    throw new RunnerWorktreeChangedError(runner, status.slice(0, 2000));
  }
}

function git(args: readonly string[], cwd: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30000,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(res.stderr ?? "").slice(0, 2000)}`);
  }
  return res.stdout.trim();
}

function gitStatus(repoPath: string): string {
  return git(
    ["status", "--porcelain", "--untracked-files=all", "--ignored=matching"],
    repoPath
  );
}
