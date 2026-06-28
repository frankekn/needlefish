#!/usr/bin/env node
import { runGithub } from "./adapters/github";
import { runLocal, printLocal, type LocalOptions } from "./adapters/local";
import { parseArgs, USAGE } from "./cli/args";

async function main() {
  const command = parseArgs(process.argv.slice(2));

  switch (command.kind) {
    case "version":
      process.stdout.write("needlefish 0.1.0\n");
      return;
    case "help":
      process.stdout.write(USAGE);
      return;
    case "github": {
      if (command.fix) {
        process.stderr.write("--fix is not implemented in v0.1 (see FUTURE_TODO.md).\n");
        process.exitCode = 2;
        return;
      }
      if (command.recheck) {
        process.stderr.write(
          "v0.1 --recheck runs a full re-review; smart prior-findings verification is TODO.\n"
        );
      }
      await runGithub(command.repo ?? process.cwd(), command.pr);
      return;
    }
    case "local": {
      if (command.fix) {
        process.stderr.write("--fix is not implemented in v0.1 (see FUTURE_TODO.md).\n");
        process.exitCode = 2;
        return;
      }
      if (command.recheck) {
        process.stderr.write(
          "v0.1 --recheck runs a full re-review; smart prior-findings verification is TODO.\n"
        );
      }
      const opts: LocalOptions = command.opts;
      const result = await runLocal(command.repo ?? process.cwd(), opts);
      printLocal(result);
      return;
    }
  }
}

main().catch((err) => {
  process.stderr.write(`needlefish: ${err instanceof Error ? err.message : err}\n`);
  process.exitCode = 1;
});
