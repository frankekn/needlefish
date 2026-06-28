import type { LocalOptions } from "../adapters/local";

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
  needlefish --github --pr 123     GitHub Action mode (post review + check)
  needlefish --recheck             re-run review on current head

Env:
  CODEX_BIN           codex executable (default: codex)
  CODEX_MODEL         model id
  CODEX_TIMEOUT_MS    per-call timeout (default: 600000)
`;

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
  const pr = Number(value);
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new Error("--pr requires a positive integer");
  }
  return pr;
}

export function parseArgs(argv: readonly string[]): CliCommand {
  let github = false;
  let pr: number | undefined;
  let repo: string | undefined;
  const opts: LocalOptions = {};
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
    throw new Error(`unknown option ${arg}`);
  }

  if (github) {
    if (!pr) throw new Error("--github requires --pr <number>");
    if (opts.base) throw new Error("--base is only valid in local mode");
    if (opts.focus) throw new Error("--focus is only valid in local mode");
    if (opts.deep) throw new Error("--deep is only valid in local mode");
    return { kind: "github", pr, repo, fix, recheck };
  }

  return { kind: "local", repo, opts, fix, recheck };
}
