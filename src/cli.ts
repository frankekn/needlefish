#!/usr/bin/env node
import { runCachedRender, runCachedVerdict } from "./adapters/cached.js";
import { runGithubExplain } from "./adapters/explain.js";
import { runGithub } from "./adapters/github.js";
import {
  runLocal,
  runLocalPr,
  printLocal,
  localDryRun,
  localPrDryRun,
  printDryRun,
} from "./adapters/local.js";
import { parseArgs, USAGE } from "./cli/args.js";
import { resolveConnectionOptions } from "./shared/connections.js";
import { serializeReviewResult } from "./shared/schema.js";
import { initializeTempLifecycle } from "./shared/temp-lifecycle.js";
import { readFileSync } from "node:fs";

// package.json sits one level above both src/ (dev) and dist/ (published).
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

async function main() {
  const command = parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case "version":
      process.stdout.write(`needlefish ${VERSION}\n`);
      return;
    case "help":
      process.stdout.write(USAGE);
      return;
    // Cached-result commands are read-only file diagnostics: no temp
    // lifecycle, no runner, no cache writes.
    case "render":
      runCachedRender(command.file);
      return;
    case "verdict":
      runCachedVerdict(command.file);
      return;
  }

  const opts = resolveConnectionOptions(command.opts, command.repo ?? process.cwd());

  // --dry-run only collects and prints the bundle: no runners spawn, so the
  // runner temp-dir lifecycle (signal handlers, startup sweep) stays off.
  const dryRun =
    (command.kind === "local" || command.kind === "pr") && command.dryRun;
  if (!dryRun) await initializeTempLifecycle();

  switch (command.kind) {
    case "github": {
      if (command.fix) {
        process.stderr.write("--fix is not implemented (see FUTURE_TODO.md).\n");
        process.exitCode = 2;
        return;
      }
      await runGithub(command.repo ?? process.cwd(), command.pr, opts, command.recheck);
      return;
    }
    case "explain": {
      await runGithubExplain(command.repo ?? process.cwd(), command.pr, command.finding, opts);
      return;
    }
    case "local":
    case "pr": {
      if (command.fix) {
        process.stderr.write("--fix is not implemented (see FUTURE_TODO.md).\n");
        process.exitCode = 2;
        return;
      }
      if (command.dryRun) {
        const cwd = command.repo ?? process.cwd();
        const report =
          command.kind === "pr"
            ? localPrDryRun(cwd, command.pr, opts)
            : localDryRun(cwd, opts);
        printDryRun(report, {
          json: command.json,
          printBundle: command.printBundle,
        });
        return;
      }
      if (command.recheck) {
        process.stderr.write(
          "--recheck runs a full re-review; smart prior-findings verification is TODO.\n"
        );
      }
      const cwd = command.repo ?? process.cwd();
      const result =
        command.kind === "pr" ? await runLocalPr(cwd, command.pr, opts) : await runLocal(cwd, opts);
      if (command.json) {
        process.stdout.write(serializeReviewResult(result));
      } else {
        printLocal(result);
      }
      return;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`needlefish: ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
