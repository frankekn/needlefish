#!/usr/bin/env node
import { runCachedRender, runCachedVerdict } from "./adapters/cached.js";
import { renderDoctorReport, runDoctor, serializeDoctorReport } from "./adapters/doctor.js";
import { runGithubExplain } from "./adapters/explain.js";
import { runGithub } from "./adapters/github.js";
import {
  runLocal,
  runLocalPr,
  printLocal,
  localDryRun,
  localPrDryRun,
  printDryRun,
  terminalProgress,
} from "./adapters/local.js";
import { parseArgs, USAGE } from "./cli/args.js";
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
    // doctor spawns only runner status commands, never a review attempt, so
    // it stays outside the runner temp lifecycle too.
    case "doctor": {
      const report = runDoctor({
        repo: command.repo ?? process.cwd(),
        version: VERSION,
        ...(command.runner !== undefined ? { runner: command.runner } : {}),
        ...(command.base !== undefined ? { base: command.base } : {}),
      });
      process.stdout.write(command.json ? serializeDoctorReport(report) : renderDoctorReport(report));
      if (!report.ok) process.exitCode = 1;
      return;
    }
  }

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
      await runGithub(command.repo ?? process.cwd(), command.pr, command.opts, command.recheck);
      return;
    }
    case "explain": {
      await runGithubExplain(command.repo ?? process.cwd(), command.pr, command.finding, command.opts);
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
            ? localPrDryRun(cwd, command.pr, command.opts)
            : localDryRun(cwd, command.opts);
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
      const progress = terminalProgress(process.stderr, command.json);
      const result =
        command.kind === "pr"
          ? await runLocalPr(cwd, command.pr, command.opts, progress)
          : await runLocal(cwd, command.opts, progress);
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
