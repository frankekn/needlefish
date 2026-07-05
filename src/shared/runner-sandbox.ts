import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { RunnerName } from "./runner";

export interface RunnerSandbox {
  readonly repoPath: string;
  readonly prompt: string;
  readonly expectedHeadSha: string;
}

export interface RunnerSandboxOptions {
  readonly runner: RunnerName;
  readonly repoPath: string;
  readonly prompt: string;
  readonly targetHeadSha: string;
  readonly targetPatch?: string;
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
  const sourceRepoPath = path.resolve(options.repoPath);
  if (options.targetHeadSha === "WORKING") {
    return prepareWorkingSandbox(options, sourceRepoPath, sandboxPath);
  }
  git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", sourceRepoPath, sandboxPath], sourceRepoPath);
  git(["fetch", "--quiet", sourceRepoPath, options.targetHeadSha], sandboxPath);
  git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], sandboxPath);
  return {
    repoPath: sandboxPath,
    prompt: options.prompt.split(sourceRepoPath).join(sandboxPath),
    expectedHeadSha: options.targetHeadSha,
  };
}

function prepareWorkingSandbox(
  options: RunnerSandboxOptions,
  sourceRepoPath: string,
  sandboxPath: string
): RunnerSandbox {
  if (!options.targetPatch?.trim()) {
    throw new Error("WORKING sandbox requires a target patch");
  }
  if (hasHeadCommit(sourceRepoPath)) {
    git(["clone", "--quiet", "--no-hardlinks", sourceRepoPath, sandboxPath], sourceRepoPath);
  } else {
    mkdirSync(sandboxPath, { recursive: true });
    git(["init", "--quiet"], sandboxPath);
  }
  git(["apply", "--whitespace=nowarn"], sandboxPath, options.targetPatch);
  git(["add", "-A"], sandboxPath);
  git(
    [
      "-c",
      "user.name=Needlefish Sandbox",
      "-c",
      "user.email=needlefish-sandbox@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "needlefish working tree",
    ],
    sandboxPath
  );
  const expectedHeadSha = git(["rev-parse", "HEAD"], sandboxPath);
  return {
    repoPath: sandboxPath,
    prompt: options.prompt.split(sourceRepoPath).join(sandboxPath),
    expectedHeadSha,
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
    status = actionableStatus(gitStatus(repoPath));
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

function hasHeadCommit(cwd: string): boolean {
  try {
    git(["cat-file", "-e", "HEAD^{commit}"], cwd);
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function git(args: readonly string[], cwd: string, input?: string): string {
  const res = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
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

function actionableStatus(status: string): string {
  return status
    .split(/\r?\n/)
    .filter((line) => line !== "" && !isCodeGraphCacheStatus(line))
    .join("\n");
}

function isCodeGraphCacheStatus(line: string): boolean {
  const statusCode = line.slice(0, 2);
  const file = line.slice(3);
  return (
    (statusCode === "??" || statusCode === "!!") &&
    (file === ".codegraph" || file.startsWith(".codegraph/"))
  );
}
