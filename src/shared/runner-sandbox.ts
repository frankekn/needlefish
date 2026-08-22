import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunnerName } from "./runner.js";
import { RunnerTerminatingError } from "./temp-lifecycle.js";

// Git has no "ignore local config" switch. Global/system/parent env are dropped
// entirely (closed by default). Local keys that spawn processes are overridden
// on the command line; remaining local identity keys (filemode, ignorecase)
// must still apply or `git status` lies. Aliases cannot replace builtins we
// invoke. GIT_CONFIG_GLOBAL/SYSTEM need git >= 2.32; HOME=/dev/null and
// GIT_CONFIG_NOSYSTEM=1 are the degrade path for older git.
const NEUTRAL_GIT_ARGS = [
  "--no-pager",
  "-c",
  "core.fsmonitor=",
  "-c",
  "core.useBuiltinFSMonitor=false",
  "-c",
  "core.hooksPath=/dev/null",
  "-c",
  "core.pager=cat",
  "-c",
  "core.sshCommand=",
  "-c",
  "core.editor=true",
  "-c",
  "sequence.editor=true",
  "-c",
  "core.askPass=",
  "-c",
  "credential.helper=",
  "-c",
  "diff.external=",
] as const;

// git status does not report .git/config or hooks. Fingerprint those at
// sandbox creation and fail the assertion if they change.
const sandboxGitMetadata = new Map<string, string>();

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
  return error instanceof RunnerWorktreeChangedError || error instanceof RunnerTerminatingError;
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
  recordGitMetadata(sandboxPath);
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
  // Write patch to a file rather than piping via stdin: multi-byte (CJK) hunks
  // plus hand-joined untracked diffs were rejected as "corrupt patch" on stdin.
  // Also ensure a trailing newline (upstream helpers may trim stdout).
  const patchInput = options.targetPatch.endsWith("\n")
    ? options.targetPatch
    : `${options.targetPatch}\n`;
  const patchFile = path.join(options.tmp, "working.patch");
  writeFileSync(patchFile, patchInput);
  git(["apply", "--whitespace=nowarn", patchFile], sandboxPath);
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
  recordGitMetadata(sandboxPath);
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
  const metadataKey = path.resolve(repoPath);
  try {
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
    const expectedMetadata = sandboxGitMetadata.get(metadataKey);
    if (
      expectedMetadata !== undefined &&
      expectedMetadata !== fingerprintGitSecurityMetadata(repoPath)
    ) {
      throw new RunnerWorktreeChangedError(runner, ".git/config or hooks changed");
    }
  } finally {
    sandboxGitMetadata.delete(metadataKey);
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
  const res = spawnSync("git", [...NEUTRAL_GIT_ARGS, ...args], {
    cwd,
    env: gitEnv(),
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

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LC_ALL: "C",
    LANG: "C",
    HOME: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_HOOKS_PATH: "/dev/null",
    GIT_PAGER: "cat",
    GIT_EDITOR: "true",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_CONFIG_COUNT: "0",
  };
  const tmp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP;
  if (tmp !== undefined) env.TMPDIR = tmp;
  return env;
}

function recordGitMetadata(repoPath: string): void {
  sandboxGitMetadata.set(path.resolve(repoPath), fingerprintGitSecurityMetadata(repoPath));
}

function fingerprintGitSecurityMetadata(repoPath: string): string {
  const hash = createHash("sha256");
  const gitDirPath = path.join(repoPath, ".git");
  appendFileHash(hash, path.join(gitDirPath, "config"));
  const hooksDir = path.join(gitDirPath, "hooks");
  const hookFiles = listFiles(hooksDir);
  hash.update(`hooks:${hookFiles.length}\n`);
  for (const file of hookFiles) {
    hash.update(`${path.relative(hooksDir, file)}\0`);
    appendFileHash(hash, file);
  }
  return hash.digest("hex");
}

function appendFileHash(hash: ReturnType<typeof createHash>, filePath: string): void {
  try {
    hash.update(readFileSync(filePath));
  } catch {
    hash.update("missing");
  }
}

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else files.push(full);
    }
  }
  return files.sort();
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
