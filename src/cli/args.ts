import type { LocalOptions } from "../adapters/local.js";
import {
  parsePositiveInteger,
  parseRunnerName,
  type RunnerName,
  type RunnerOptions,
} from "../shared/runner.js";

export type CliCommand =
  | {
      readonly kind: "help" | "version";
    }
  | {
      readonly kind: "render" | "verdict";
      readonly file: string;
    }
  | {
      readonly kind: "local";
      readonly repo?: string;
      readonly opts: LocalOptions;
      readonly fix: boolean;
      readonly recheck: boolean;
      readonly json: boolean;
      readonly dryRun: boolean;
      readonly printBundle: boolean;
    }
  | {
      readonly kind: "github";
      readonly pr: number;
      readonly repo?: string;
      readonly opts: RunnerOptions;
      readonly fix: boolean;
      readonly recheck: boolean;
    }
  | {
      readonly kind: "pr";
      readonly pr: number;
      readonly repo?: string;
      readonly opts: LocalOptions;
      readonly fix: boolean;
      readonly recheck: boolean;
      readonly json: boolean;
      readonly dryRun: boolean;
      readonly printBundle: boolean;
    }
  | {
      readonly kind: "explain";
      readonly pr: number;
      readonly finding: string;
      readonly repo?: string;
      readonly opts: RunnerOptions;
    };

export const USAGE = `Needlefish — strict local PR review agent.

Usage:
  needlefish [options]                 review local changes (uncommitted when dirty)
  needlefish pr <number> [options]     review PR base..head via gh (any branch)
  needlefish --github --pr <number>    GitHub Action mode (post review + check)
  needlefish explain <number> --finding <text>
                                       explain one finding on a PR (Action mode)
  needlefish render <file>             re-render a cached last-review.json
  needlefish verdict <file>            recompute a cached result's verdict
                                       (exits 1 when stored and derived differ)

Shared options:
  --repo <path>        target repository
  --focus <text>       narrow the review lens
  --deep               wider context (call sites, history, adjacent tests)
  --runner <name>      codex | claude | opencode | openai | grok | pi | acp
  --model <id>         model id for the selected runner
  --timeout-ms <ms>    per-call timeout
  --recheck            re-run review on current target
  --json               print ReviewResult JSON to stdout (local/pr only)
  --dry-run            collect the review bundle and print a summary; no model
                       calls and no cache write (local and pr only)
  --print-bundle       with --dry-run, print the full bundle JSON — includes
                       the whole diff and the repo AGENTS.md policy text

Local diff options:
  --pr <number>        attach PR metadata to the local diff review
  --base <ref>         override base ref
  --uncommitted        review staged, unstaged, and untracked working-tree changes
  --branch             review merge-base..HEAD even when the worktree is dirty

Env:
  NEEDLEFISH_RUNNER       codex | claude | opencode | openai | grok | pi | acp (default: auto-detect codex, claude, opencode)
  NEEDLEFISH_MODEL        model id for the selected runner
  NEEDLEFISH_TIMEOUT_MS   per-call timeout (default: 600000)
  CODEX_BIN               codex executable (default: codex)
  CLAUDE_BIN              claude executable (default: claude)
  OPENCODE_BIN            opencode executable (default: opencode)
  OPENCODE_IDLE_TIMEOUT_MS opencode inactivity timeout (default: min of per-call timeout and 600000)
  PI_BIN                  pi executable (default: pi)
  NEEDLEFISH_ACP_BIN      ACP agent executable (required for acp)
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
  localMode?: "uncommitted" | "branch";
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
  const cachedCommand =
    argv[0] === "render" || argv[0] === "verdict" ? argv[0] : undefined;
  if (cachedCommand) {
    if (argv[1] === "-h" || argv[1] === "--help") return { kind: "help" };
    if (argv[1] === "-v" || argv[1] === "--version") return { kind: "version" };
    const file = argv[1];
    if (!file || file.startsWith("-")) {
      throw new Error(`${cachedCommand} requires a path to a cached review JSON file`);
    }
    if (argv.length > 2) {
      throw new Error(`${cachedCommand} takes exactly one file argument`);
    }
    return { kind: cachedCommand, file };
  }
  const explainCommand = argv[0] === "explain";
  const prCommand = argv[0] === "pr" || explainCommand;
  if (prCommand && (argv[1] === "-h" || argv[1] === "--help")) return { kind: "help" };
  if (prCommand && (argv[1] === "-v" || argv[1] === "--version")) return { kind: "version" };
  const prCommandNumber = prCommand ? parsePositiveInteger(argv[1] ?? "", explainCommand ? "explain" : "pr") : undefined;
  const start = prCommand ? 2 : 0;
  let finding: string | undefined;
  let github = false;
  let pr: number | undefined;
  let repo: string | undefined;
  const opts: MutableLocalOptions = {};
  let fix = false;
  let recheck = false;
  let json = false;
  let dryRun = false;
  let printBundle = false;
  let sawUncommitted = false;
  let sawBranch = false;

  for (let i = start; i < argv.length; i++) {
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
    if (arg === "--uncommitted") {
      sawUncommitted = true;
      opts.localMode = "uncommitted";
      continue;
    }
    if (arg === "--branch") {
      sawBranch = true;
      opts.localMode = "branch";
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
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--print-bundle") {
      printBundle = true;
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
    if (arg === "--finding") {
      finding = takeValue(argv, i, "--finding");
      i++;
      continue;
    }
    if (arg.startsWith("--finding=")) {
      finding = inlineValue(arg, "--finding");
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

  if (sawUncommitted && sawBranch) {
    throw new Error("--uncommitted cannot be combined with --branch");
  }

  if (printBundle && !dryRun) {
    throw new Error("--print-bundle requires --dry-run");
  }

  if (github) {
    if (prCommand) throw new Error("pr command cannot be combined with --github");
    if (!pr) throw new Error("--github requires --pr <number>");
    if (json) throw new Error("--json is not supported with --github");
    if (dryRun) throw new Error("--dry-run is not supported with --github");
    if (opts.base) throw new Error("--base is only valid in local mode");
    if (opts.localMode) throw new Error("--uncommitted and --branch are only valid in local mode");
    if (opts.focus) throw new Error("--focus is only valid in local mode");
    if (opts.deep) throw new Error("--deep is only valid in local mode");
    return { kind: "github", pr, repo, opts: runnerOptionsFrom(opts), fix, recheck };
  }

  if (explainCommand) {
    if (json) throw new Error("--json is only valid in local and pr modes");
    if (dryRun) throw new Error("--dry-run is only valid in local and pr modes");
    if (!finding) throw new Error("explain requires --finding <text>");
    return { kind: "explain", pr: prCommandNumber!, finding, repo, opts: runnerOptionsFrom(opts) };
  }
  if (finding !== undefined) throw new Error("--finding is only valid with the explain command");

  if (prCommand) {
    if (pr) throw new Error("pr command cannot be combined with --pr");
    if (opts.base) throw new Error("--base is not valid with pr command");
    if (opts.localMode) throw new Error("--uncommitted and --branch are not valid with pr command");
    return { kind: "pr", pr: prCommandNumber!, repo, opts, fix, recheck, json, dryRun, printBundle };
  }

  return { kind: "local", repo, opts, fix, recheck, json, dryRun, printBundle };
}
