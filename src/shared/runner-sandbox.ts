import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeFileSync,
} from "node:fs";
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
    if (expectedMetadata !== undefined) {
      let actualMetadata: string;
      try {
        actualMetadata = fingerprintGitSecurityMetadata(repoPath);
      } catch (error) {
        // A refused entry shape is itself a mutation of the metadata this check
        // guards, so it must surface as a runner safety error (retry-suppressing
        // via isRunnerSafetyError) rather than as an opaque I/O failure.
        if (error instanceof GitMetadataShapeError) {
          throw new RunnerWorktreeChangedError(runner, error.message);
        }
        throw error;
      }
      if (expectedMetadata !== actualMetadata) {
        throw new RunnerWorktreeChangedError(runner, ".git/config or hooks changed");
      }
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

// Everything below runs in the PARENT process, after the runner subprocess has
// exited, against paths the runner could write. Two properties of that trust
// boundary make an unguarded read fatal rather than merely untidy:
//
//   1. There is no OS-level jail. `runner-process.ts` spawns the model CLI with
//      plain spawn/spawnSync — no bwrap, chroot, seccomp, or container — so the
//      runner can create any file type inside its own sandbox clone, including
//      a FIFO or a symlink pointing outside it. (See the AGENTS.md convention:
//      runners deliberately run unrestricted; the throwaway clone plus *these*
//      post-run checks are the isolation.)
//   2. The runner's own containment does not cover us. The subprocess timeout
//      and the 64MB output cap bound the *child*; this fingerprint runs after
//      the child is gone, with no timeout of its own. A blocking read here
//      hangs the review forever and an unbounded one exhausts parent memory —
//      neither is caught by anything upstream.
//
// So only regular files of plausible size are hashed, and the entry type is
// resolved from the file descriptor we actually read (O_NOFOLLOW + fstat), not
// from a path stat that a concurrent writer could invalidate. Anything else
// fails the integrity check closed: a symlink, FIFO, socket, device node, or
// multi-megabyte blob under .git is itself evidence that git metadata was
// mutated, which is precisely what this check exists to detect. Skipping such
// an entry would convert the loudest possible signal into silence.
const MAX_GIT_METADATA_BYTES = 1024 * 1024;

// O_NOFOLLOW makes a symlinked final component fail with ELOOP instead of being
// followed; O_NONBLOCK keeps open() itself from blocking on a FIFO with no
// writer (O_NOFOLLOW alone does not help there). Both are POSIX-only; on a
// platform lacking them the fstat check below is still the guard that holds.
const SAFE_OPEN_FLAGS =
  fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

class GitMetadataShapeError extends Error {
  readonly name = "GitMetadataShapeError";
}

function errnoCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function appendFileHash(hash: ReturnType<typeof createHash>, filePath: string): void {
  let fd: number;
  try {
    fd = openSync(filePath, SAFE_OPEN_FLAGS);
  } catch (error) {
    // A genuinely absent path is a normal fingerprint input (a repo with no
    // hooks, a hook deleted between listing and hashing): hash the absence, so
    // a deletion still changes the digest. Every other failure — ELOOP from a
    // symlink, EACCES from a chmod'd file — is a shape we refuse to hash.
    if (errnoCode(error) === "ENOENT") {
      hash.update("missing");
      return;
    }
    throw new GitMetadataShapeError(
      `refusing to hash ${filePath}: open failed (${errnoCode(error) ?? String(error)})`
    );
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new GitMetadataShapeError(`refusing to hash non-regular git metadata entry ${filePath}`);
    }
    if (stat.size > MAX_GIT_METADATA_BYTES) {
      throw new GitMetadataShapeError(
        `refusing to hash oversized git metadata entry ${filePath} (${stat.size} bytes)`
      );
    }
    // Read through the descriptor with an explicitly sized buffer: readFileSync
    // would re-stat and keep reading a file that grows under us.
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    hash.update(buffer.subarray(0, offset));
  } finally {
    closeSync(fd);
  }
}

function listFiles(dir: string): string[] {
  let root;
  try {
    root = lstatSync(dir);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw new GitMetadataShapeError(
      `refusing to walk ${dir}: lstat failed (${errnoCode(error) ?? String(error)})`
    );
  }
  // lstat, not existsSync: a hooks directory replaced by a symlink would
  // otherwise be followed, walking and reading whatever it points at.
  if (!root.isDirectory()) {
    throw new GitMetadataShapeError(`refusing to walk non-directory git metadata path ${dir}`);
  }
  const files: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch (error) {
      throw new GitMetadataShapeError(
        `refusing to walk ${current}: readdir failed (${errnoCode(error) ?? String(error)})`
      );
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      // Dirent types come from d_type and are not resolved through symlinks.
      // Only these two shapes are expected under .git; an UNKNOWN d_type also
      // lands in the reject branch, which is the fail-closed direction.
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
      else {
        throw new GitMetadataShapeError(
          `refusing to hash non-regular git metadata entry ${full}`
        );
      }
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
