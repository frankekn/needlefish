#!/usr/bin/env node
import { runGithub } from "./adapters/github";
import { runLocal, printLocal, type LocalOptions } from "./adapters/local";

function parse(argv: string[]): {
  github: boolean;
  pr?: number;
  repo?: string;
  opts: LocalOptions;
  fix: boolean;
  recheck: boolean;
} {
  const out = {
    github: false,
    pr: undefined as number | undefined,
    repo: undefined as string | undefined,
    opts: {} as LocalOptions,
    fix: false,
    recheck: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--github":
        out.github = true;
        break;
      case "--pr":
        out.pr = Number(argv[++i]);
        out.opts.pr = out.pr;
        break;
      case "--base":
        out.opts.base = argv[++i];
        break;
      case "--repo":
        out.repo = argv[++i];
        break;
      case "--deep":
        out.opts.deep = true;
        break;
      case "--focus":
        out.opts.focus = argv[++i];
        break;
      case "--fix":
        out.fix = true;
        break;
      case "--recheck":
        out.recheck = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(USAGE);
        process.exit(0);
        break;
      default:
        if (a?.startsWith("--base=")) out.opts.base = a.slice(7);
        else if (a?.startsWith("--pr=")) {
          out.pr = Number(a.slice(5));
          out.opts.pr = out.pr;
        }         else if (a?.startsWith("--focus=")) out.opts.focus = a.slice(8);
        else if (a?.startsWith("--repo=")) out.repo = a.slice(7);
    }
  }
  return out;
}

const USAGE = `Needlefish — strict local PR review agent.

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

async function main() {
  if (process.argv.slice(2).some((a) => a === "-v" || a === "--version")) {
    process.stdout.write("needlefish 0.1.0\n");
    process.exit(0);
  }
  const { github, pr, repo, opts, fix, recheck } = parse(process.argv.slice(2));

  if (fix) {
    process.stderr.write("--fix is not implemented in v0.1 (see FUTURE_TODO.md).\n");
    process.exitCode = 2;
    return;
  }
  if (recheck) {
    process.stderr.write(
      "v0.1 --recheck runs a full re-review; smart prior-findings verification is TODO.\n"
    );
  }

  const cwd = repo ?? process.cwd();

  if (github) {
    if (!pr) throw new Error("--github requires --pr <number>");
    await runGithub(cwd, pr);
    return;
  }

  const result = await runLocal(cwd, opts);
  printLocal(result);
}

main().catch((err) => {
  process.stderr.write(`needlefish: ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
