#!/usr/bin/env node
import { runGithubExplain } from "./adapters/explain.js";
import { runGithub } from "./adapters/github.js";
import { runLocal, runLocalPr, printLocal } from "./adapters/local.js";
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
  }

  await initializeTempLifecycle();

  switch (command.kind) {
    case "github": {
      if (command.fix) {
        process.stderr.write("--fix is not implemented in v0.2 (see FUTURE_TODO.md).\n");
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
        process.stderr.write("--fix is not implemented in v0.2 (see FUTURE_TODO.md).\n");
        process.exitCode = 2;
        return;
      }
      if (command.recheck) {
        process.stderr.write(
          "v0.2 --recheck runs a full re-review; smart prior-findings verification is TODO.\n"
        );
      }
      const cwd = command.repo ?? process.cwd();
      const result =
        command.kind === "pr" ? await runLocalPr(cwd, command.pr, command.opts) : await runLocal(cwd, command.opts);
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
