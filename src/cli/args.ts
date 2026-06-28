import type { LocalOptions } from "../adapters/local";
import {
  parsePositiveInteger,
  parseRunnerName,
  type RunnerName,
  type RunnerOptions,
} from "../shared/runner";

export type CliCommand =
  | {
      readonly kind: "help" | "version";
    }
  | {
      readonly kind: "local";
      readonly repo?: string;
      readonly opts: LocalOptions;
      readonly fix: boolean;
      readonly recheck: boolean;
    }
  | {
      readonly kind: "github";
      readonly pr: number;
      readonly repo?: string;
      readonly opts: RunnerOptions;
      readonly fix: boolean;
      readonly recheck: boolean;
    };

export const USAGE = `Needlefish — strict local PR review agent.

Usage:
  needlefish                       review merge-base..HEAD (local, read-only)
  needlefish --focus security      narrow the review lens
  needlefish --deep                wider context (call sites, history, adjacent tests)
  needlefish --pr 123              also pull PR body/comments/checks via gh
  needlefish --base develop        override base ref
  needlefish --runner claude       run with codex, claude, or opencode
  needlefish --github --pr 123     GitHub Action mode (post review + check)
  needlefish --recheck             re-run review on current head

Env:
  NEEDLEFISH_RUNNER       codex | claude | opencode (default: codex)
  NEEDLEFISH_MODEL        model id for the selected runner
  NEEDLEFISH_TIMEOUT_MS   per-call timeout (default: 600000)
  CODEX_BIN               codex executable (default: codex)
  CLAUDE_BIN              claude executable (default: claude)
  OPENCODE_BIN            opencode executable (default: opencode)
`;

type MutableLocalOptions = {
  base?: string;
  pr?: number;
  deep?: boolean;
  focus?: string;
  cacheDir?: string;
  runner?: RunnerName;
  model?: string;
  timeoutMs?: number;
};

type MutableRunnerOptions = {
  runner?: RunnerName;
  model?: string;
  timeoutMs?: number;
};

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function inlineValue(arg: string, flag: string): string {
  const value = arg.slice(flag.length + 1);
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePr(value: string): number {
  return parsePositiveInteger(value, "--pr");
}

function runnerOptionsFrom(opts: MutableLocalOptions): RunnerOptions {
  const runnerOpts: MutableRunnerOptions = {};
  if (opts.runner) runnerOpts.runner = opts.runner;
  if (opts.model) runnerOpts.model = opts.model;
  if (opts.timeoutMs) runnerOpts.timeoutMs = opts.timeoutMs;
  return runnerOpts;
}

export function parseArgs(argv: readonly string[]): CliCommand {
  let github = false;
  let pr: number | undefined;
  let repo: string | undefined;
  const opts: MutableLocalOptions = {};
  let fix = false;
  let recheck = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "-h" || arg === "--help") return { kind: "help" };
    if (arg === "-v" || arg === "--version") return { kind: "version" };
    if (arg === "--github") {
      github = true;
      continue;
    }
    if (arg === "--deep") {
      opts.deep = true;
      continue;
    }
    if (arg === "--fix") {
      fix = true;
      continue;
    }
    if (arg === "--recheck") {
      recheck = true;
      continue;
    }
    if (arg === "--pr") {
      pr = parsePr(takeValue(argv, i, "--pr"));
      opts.pr = pr;
      i++;
      continue;
    }
    if (arg === "--base") {
      opts.base = takeValue(argv, i, "--base");
      i++;
      continue;
    }
    if (arg === "--repo") {
      repo = takeValue(argv, i, "--repo");
      i++;
      continue;
    }
    if (arg === "--focus") {
      opts.focus = takeValue(argv, i, "--focus");
      i++;
      continue;
    }
    if (arg === "--runner") {
      opts.runner = parseRunnerName(takeValue(argv, i, "--runner"), "--runner");
      i++;
      continue;
    }
    if (arg === "--model") {
      opts.model = takeValue(argv, i, "--model");
      i++;
      continue;
    }
    if (arg === "--timeout-ms") {
      opts.timeoutMs = parsePositiveInteger(takeValue(argv, i, "--timeout-ms"), "--timeout-ms");
      i++;
      continue;
    }
    if (arg.startsWith("--pr=")) {
      pr = parsePr(inlineValue(arg, "--pr"));
      opts.pr = pr;
      continue;
    }
    if (arg.startsWith("--base=")) {
      opts.base = inlineValue(arg, "--base");
      continue;
    }
    if (arg.startsWith("--repo=")) {
      repo = inlineValue(arg, "--repo");
      continue;
    }
    if (arg.startsWith("--focus=")) {
      opts.focus = inlineValue(arg, "--focus");
      continue;
    }
    if (arg.startsWith("--runner=")) {
      opts.runner = parseRunnerName(inlineValue(arg, "--runner"), "--runner");
      continue;
    }
    if (arg.startsWith("--model=")) {
      opts.model = inlineValue(arg, "--model");
      continue;
    }
    if (arg.startsWith("--timeout-ms=")) {
      opts.timeoutMs = parsePositiveInteger(inlineValue(arg, "--timeout-ms"), "--timeout-ms");
      continue;
    }
    throw new Error(`unknown option ${arg}`);
  }

  if (github) {
    if (!pr) throw new Error("--github requires --pr <number>");
    if (opts.base) throw new Error("--base is only valid in local mode");
    if (opts.focus) throw new Error("--focus is only valid in local mode");
    if (opts.deep) throw new Error("--deep is only valid in local mode");
    return { kind: "github", pr, repo, opts: runnerOptionsFrom(opts), fix, recheck };
  }

  return { kind: "local", repo, opts, fix, recheck };
}
