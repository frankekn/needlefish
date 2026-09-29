import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { buildRunnerEnv, hasRunnerEnvCredential } from "../shared/codex.js";
import { git } from "../shared/repo.js";
import { RUNNER_DEFINITIONS as RUNNER_CATALOG } from "../shared/runner-definition.js";
import {
  NO_AUTO_DETECTED_RUNNER_MESSAGE,
  resolveRunnerBinary,
  type ResolvedRunnerBinary,
} from "../shared/runner-detection.js";
import { RUNNER_DEFINITIONS, RUNNERS, isRunnerName, type RunnerName } from "../shared/runner.js";
import {
  BASE_FIX,
  BaseRefError,
  hasHeadCommit,
  isGitRepo,
  localDiffMode,
  resolveReviewBase,
} from "./local.js";

export type DoctorStatus = "ok" | "fail" | "unknown";

export interface DoctorCheck {
  readonly name: "node" | "runner" | "auth" | "git" | "base";
  readonly status: DoctorStatus;
  readonly detail: string;
  readonly fix?: string;
}

export interface DoctorReport {
  readonly schemaVersion: 1;
  readonly needlefish: string;
  /** False when any check failed; an `unknown` check does not fail the report. */
  readonly ok: boolean;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorOptions {
  readonly repo: string;
  readonly version: string;
  readonly runner?: RunnerName;
  readonly base?: string;
}

// Each probe is a local status command of the runner CLI: no model call, no
// repository content. It runs under the same env allowlist a review attempt
// gets, so a credential that only exists outside that allowlist is reported
// as missing here instead of failing later inside the review.
const PROBE_TIMEOUT_MS = 10_000;
const MIN_NODE_MAJOR = 20;

type ProbeResult =
  | { readonly kind: "exited"; readonly status: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "failed"; readonly reason: string };

function probe(runner: RunnerName, command: string, args: readonly string[]): ProbeResult {
  const res = spawnSync(command, [...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    env: buildRunnerEnv(runner, path.join(os.tmpdir(), "needlefish-doctor-gh-empty")),
  });
  if (res.error) {
    const code = "code" in res.error ? res.error.code : undefined;
    return {
      kind: "failed",
      reason: code === "ETIMEDOUT" ? `timed out after ${PROBE_TIMEOUT_MS} ms` : res.error.message,
    };
  }
  if (res.status === null) return { kind: "failed", reason: `killed by ${res.signal}` };
  return { kind: "exited", status: res.status, stdout: res.stdout, stderr: res.stderr };
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.slice(0, 160) ?? "";
}

function nodeCheck(): DoctorCheck {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (major >= MIN_NODE_MAJOR) return { name: "node", status: "ok", detail: `v${version}` };
  return {
    name: "node",
    status: "fail",
    detail: `v${version} is older than the required ${MIN_NODE_MAJOR}`,
    fix: `Install Node ${MIN_NODE_MAJOR} or newer.`,
  };
}

type RunnerSelection =
  | { readonly kind: "cli"; readonly runner: RunnerName; readonly binary: ResolvedRunnerBinary & { readonly path: string } }
  | { readonly kind: "http"; readonly runner: RunnerName }
  | { readonly kind: "unavailable" };

function selectRunner(explicit: RunnerName | undefined): { readonly check: DoctorCheck; readonly selection: RunnerSelection } {
  const envRunner = process.env.NEEDLEFISH_RUNNER;
  let runner: RunnerName | undefined = explicit;
  if (runner === undefined && envRunner) {
    if (!isRunnerName(envRunner)) {
      return {
        check: {
          name: "runner",
          status: "fail",
          detail: `NEEDLEFISH_RUNNER=${envRunner} is not a supported runner`,
          fix: `Set NEEDLEFISH_RUNNER to one of: ${RUNNERS.join(", ")}.`,
        },
        selection: { kind: "unavailable" },
      };
    }
    runner = envRunner;
  }
  if (runner === undefined) {
    for (const candidate of RUNNER_CATALOG) {
      if (!("autoDetect" in candidate)) continue;
      const binary = resolveRunnerBinary(candidate.name);
      if (binary?.path !== undefined) return cliRunnerCheck(candidate.name, { ...binary, path: binary.path }, "auto-detected");
    }
    const [summary, ...installLines] = NO_AUTO_DETECTED_RUNNER_MESSAGE.split("\n");
    return {
      check: { name: "runner", status: "fail", detail: summary, fix: installLines.join("\n") },
      selection: { kind: "unavailable" },
    };
  }
  const definition = RUNNER_DEFINITIONS[runner];
  if (definition.bin === undefined) {
    return {
      check: { name: "runner", status: "ok", detail: `${runner} (HTTP runner, no CLI)` },
      selection: { kind: "http", runner },
    };
  }
  const binary = resolveRunnerBinary(runner);
  if (binary === undefined) {
    return {
      check: {
        name: "runner",
        status: "fail",
        detail: `${runner}: ${definition.bin.env} is not set`,
        fix: `Set ${definition.bin.env} to the ${runner} executable.`,
      },
      selection: { kind: "unavailable" },
    };
  }
  if (binary.path === undefined) {
    const install = definition.autoDetect?.installCommand;
    return {
      check: {
        name: "runner",
        status: "fail",
        detail: `${runner}: ${binary.command} not found on PATH`,
        fix:
          install === undefined
            ? `Set ${definition.bin.env} to the ${runner} executable.`
            : `Install it with \`${install}\`, or set ${definition.bin.env} to its executable.`,
      },
      selection: { kind: "unavailable" },
    };
  }
  return cliRunnerCheck(runner, { ...binary, path: binary.path }, explicit === undefined ? "NEEDLEFISH_RUNNER" : "--runner");
}

function cliRunnerCheck(
  runner: RunnerName,
  binary: ResolvedRunnerBinary & { readonly path: string },
  source: string,
): { readonly check: DoctorCheck; readonly selection: RunnerSelection } {
  // An ACP agent is a JSON-RPC process; `--version` is not part of that contract.
  const version = runner === "acp" ? undefined : probe(runner, binary.path, ["--version"]);
  const versionText =
    version === undefined
      ? ""
      : version.kind === "exited" && version.status === 0
        ? `, ${firstLine(version.stdout) || "version unknown"}`
        : ", version unknown";
  return {
    check: { name: "runner", status: "ok", detail: `${runner} (${source}; ${binary.path}${versionText})` },
    selection: { kind: "cli", runner, binary },
  };
}

function authCheck(selection: RunnerSelection): DoctorCheck {
  if (selection.kind === "unavailable") {
    return { name: "auth", status: "unknown", detail: "skipped: no runner available" };
  }
  const { runner } = selection;
  if (selection.kind === "http") {
    // runOpenAIDirect requires OPENAI_API_KEY; the key itself is never read here.
    return process.env.OPENAI_API_KEY
      ? { name: "auth", status: "ok", detail: `${runner}: OPENAI_API_KEY is set` }
      : { name: "auth", status: "fail", detail: `${runner}: OPENAI_API_KEY is not set`, fix: "Set OPENAI_API_KEY." };
  }
  // The review accepts these setups without the CLI's own credential store,
  // so the CLI's login state is not the question. The value is never shown.
  if (hasRunnerEnvCredential(runner)) {
    return { name: "auth", status: "ok", detail: `${runner}: env credential configured; CLI login state not probed` };
  }
  const login = RUNNER_DEFINITIONS[runner].login;
  if (login === undefined) {
    return { name: "auth", status: "unknown", detail: `${runner}: no login status command known for this CLI` };
  }
  if (login.status === undefined) {
    return {
      name: "auth",
      status: "unknown",
      detail: `${runner}: no login status command known; \`${login.command}\` signs in`,
    };
  }
  const fix = `Run \`${login.command}\`.`;
  const result = probe(runner, selection.binary.path, login.status.args);
  const probeCommand = `${selection.binary.command} ${login.status.args.join(" ")}`;
  if (result.kind === "failed") {
    return { name: "auth", status: "unknown", detail: `${runner}: \`${probeCommand}\` ${result.reason}` };
  }
  const reported = firstLine(result.stdout) || firstLine(result.stderr);
  switch (login.status.loggedIn) {
    case "exit-zero":
      return result.status === 0
        ? { name: "auth", status: "ok", detail: `${runner}: ${reported || "logged in"}` }
        : { name: "auth", status: "fail", detail: `${runner}: ${reported || "not logged in"}`, fix };
    case "non-empty-json-array": {
      if (result.status !== 0) {
        return {
          name: "auth",
          status: "unknown",
          detail: `${runner}: \`${probeCommand}\` exited ${result.status}${reported ? ` (${reported})` : ""}`,
        };
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(result.stdout);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        return { name: "auth", status: "unknown", detail: `${runner}: \`${probeCommand}\` did not print JSON` };
      }
      if (!Array.isArray(parsed)) {
        return { name: "auth", status: "unknown", detail: `${runner}: \`${probeCommand}\` did not print a JSON array` };
      }
      return parsed.length > 0
        ? { name: "auth", status: "ok", detail: `${runner}: ${parsed.length} provider credential(s) stored` }
        : { name: "auth", status: "fail", detail: `${runner}: no provider credentials stored`, fix };
    }
  }
}

/** What the default `needlefish` run in this repo would review; undefined outside a git repo. */
interface WorktreeState {
  readonly headExists: boolean;
  readonly dirty: boolean;
}

function gitCheck(repo: string): { readonly check: DoctorCheck; readonly worktree: WorktreeState | undefined } {
  if (!isGitRepo(repo)) {
    return {
      check: {
        name: "git",
        status: "fail",
        detail: `${repo} is not a git repository`,
        fix: "Run `git init` inside your project folder.",
      },
      worktree: undefined,
    };
  }
  const headExists = hasHeadCommit(repo);
  let branch: string;
  try {
    branch = git(["symbolic-ref", "--short", "-q", "HEAD"], repo);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    branch = "detached HEAD";
  }
  const changed = git(["status", "--porcelain"], repo).split("\n").filter(Boolean).length;
  const tree = changed === 0 ? "clean" : `${changed} uncommitted change(s)`;
  const commits = headExists ? "" : ", no commits yet";
  return {
    check: { name: "git", status: "ok", detail: `${repo} (branch ${branch}, ${tree}${commits})` },
    worktree: { headExists, dirty: changed > 0 },
  };
}

// The base ref matters only when the default review runs in branch mode; the
// same decision the review makes (localDiffMode) decides whether to check it.
function baseCheck(repo: string, worktree: WorktreeState | undefined, override: string | undefined): DoctorCheck {
  if (worktree === undefined) return { name: "base", status: "unknown", detail: "skipped: not a git repository" };
  if (localDiffMode(worktree.headExists, worktree.dirty, undefined) === "uncommitted") {
    const why = worktree.headExists ? "worktree has uncommitted changes" : "no commits yet";
    return { name: "base", status: "ok", detail: `not needed: ${why}, so a review covers uncommitted changes` };
  }
  try {
    const { baseRef, baseSha } = resolveReviewBase(repo, override);
    return { name: "base", status: "ok", detail: `${baseRef} (merge-base ${baseSha.slice(0, 7)})` };
  } catch (error) {
    if (!(error instanceof BaseRefError)) throw error;
    return { name: "base", status: "fail", detail: `${error.baseRef}: ${error.reason}`, fix: BASE_FIX };
  }
}

export function runDoctor(opts: DoctorOptions): DoctorReport {
  const repo = path.resolve(opts.repo);
  const runner = selectRunner(opts.runner);
  const gitState = gitCheck(repo);
  const checks: readonly DoctorCheck[] = [
    nodeCheck(),
    runner.check,
    authCheck(runner.selection),
    gitState.check,
    baseCheck(repo, gitState.worktree, opts.base),
  ];
  return {
    schemaVersion: 1,
    needlefish: opts.version,
    ok: checks.every((check) => check.status !== "fail"),
    checks,
  };
}

export function serializeDoctorReport(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = [`needlefish ${report.needlefish}`];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(8)}${check.name.padEnd(8)}${check.detail}`);
    if (check.fix !== undefined) {
      const [first, ...rest] = check.fix.split("\n");
      lines.push(`${"".padEnd(16)}fix: ${first}`);
      for (const line of rest) lines.push(`${"".padEnd(21)}${line.trim()}`);
    }
  }
  const count = (status: DoctorStatus): number => report.checks.filter((check) => check.status === status).length;
  const unknown = count("unknown");
  const failed = count("fail");
  lines.push(
    unknown === 0 && failed === 0
      ? "all checks passed"
      : `${count("ok")} passed, ${unknown} unknown, ${failed} failed`,
  );
  return `${lines.join("\n")}\n`;
}
