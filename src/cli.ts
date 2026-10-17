#!/usr/bin/env node
import { ConnectionsError, readConnectionsRequest, runConnections } from "./adapters/connections.js";
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
import { runGuidedGithubSetup } from "./setup/guided.js";
import { planGithubSetup, renderGithubSetup } from "./setup/github.js";
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
    case "connections": {
      const controller = new AbortController();
      const cancel = () => controller.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        const request = command.operation === "list" || command.operation === "edit" ? undefined : await readConnectionsRequest(process.stdin, controller.signal);
        const result = await runConnections(command.operation, command.repo ?? process.cwd(), request, process.env, controller.signal);
        process.stdout.write(JSON.stringify(result) + "\n");
        if (!result.ok) process.exitCode = 1;
      } catch (error) {
        process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, code: error instanceof ConnectionsError ? error.code : "invalid_request" }) + "\n");
        process.exitCode = 1;
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
      return;
    }
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
        ...(command.connection !== undefined ? { connection: command.connection } : {}),
        ...(command.runner !== undefined ? { runner: command.runner } : {}),
        ...(command.base !== undefined ? { base: command.base } : {}),
      });
      process.stdout.write(command.json ? serializeDoctorReport(report) : renderDoctorReport(report));
      if (!report.ok) process.exitCode = 1;
      return;
    }
    case "setup-github": {
      if (command.action) {
        try {
          const result = await runGuidedGithubSetup({ action: command.action, confirm: command.confirm === true,
            replaceSecret: command.replaceSecret === true, ...(command.repository ? { repository: command.repository } : {}) });
          process.stdout.write(JSON.stringify(result, null, command.json ? undefined : 2) + "\n");
        } catch (error) {
          if (!command.json) throw error;
          process.stdout.write(JSON.stringify({ schemaVersion: 1, phase: "error", message: error instanceof Error ? error.message : "GitHub setup failed. Retry after checking your connection." }) + "\n");
          process.exitCode = 1;
        }
        return;
      }
      const plan = planGithubSetup(command.repo ?? process.cwd());
      process.stdout.write(renderGithubSetup(plan));
      if (plan.kind === "conflict") process.exitCode = 1;
      return;
    }
  }

  if (command.kind !== "explain" && command.fix) {
    process.stderr.write("--fix is not implemented (see FUTURE_TODO.md).\n");
    process.exitCode = 2;
    return;
  }

  // --dry-run only collects and prints the bundle: no runners spawn, so the
  // runner temp-dir lifecycle (signal handlers, startup sweep) stays off.
  const dryRun =
    (command.kind === "local" || command.kind === "pr") && command.dryRun;
  const opts = command.opts;
  if (!dryRun) await initializeTempLifecycle();

  switch (command.kind) {
    case "github": {
      await runGithub(command.repo ?? process.cwd(), command.pr, opts, command.recheck);
      return;
    }
    case "explain": {
      await runGithubExplain(command.repo ?? process.cwd(), command.pr, command.finding, opts);
      return;
    }
    case "local":
    case "pr": {
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
      const progress = terminalProgress(process.stderr, command.json);
      const result =
        command.kind === "pr"
          ? await runLocalPr(cwd, command.pr, opts, progress)
          : await runLocal(cwd, opts, progress);
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
  if (process.argv[2] === "connections") {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, ok: false, code: "invalid_request" }) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`needlefish: ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
