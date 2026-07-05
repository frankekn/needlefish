import { accessSync, constants } from "node:fs";
import path from "node:path";
import { parseRunnerName, type RunnerName, type RunnerOptions } from "./runner.js";

const AUTO_DETECT_RUNNERS = ["codex", "claude", "opencode"] as const satisfies readonly RunnerName[];
type AutoDetectRunner = (typeof AUTO_DETECT_RUNNERS)[number];

const AUTO_DETECT_BIN_ENV = {
  codex: "CODEX_BIN",
  claude: "CLAUDE_BIN",
  opencode: "OPENCODE_BIN",
} as const satisfies Record<AutoDetectRunner, string>;

const NO_AUTO_DETECTED_RUNNER_MESSAGE = [
  "No supported model runner found on PATH.",
  "Install one:",
  "  codex: npm install -g @openai/codex",
  "  claude: npm install -g @anthropic-ai/claude-code",
  "  opencode: npm install -g opencode-ai",
].join("\n");

export function resolveRunner(opts: RunnerOptions): RunnerName {
  if (opts.runner) return opts.runner;
  const envRunner = process.env.NEEDLEFISH_RUNNER;
  if (envRunner) return parseRunnerName(envRunner, "NEEDLEFISH_RUNNER");
  return autoDetectRunner();
}

function autoDetectRunner(): RunnerName {
  for (const runner of AUTO_DETECT_RUNNERS) {
    if (runnerExists(runner)) return runner;
  }
  throw new Error(NO_AUTO_DETECTED_RUNNER_MESSAGE);
}

function runnerExists(runner: AutoDetectRunner): boolean {
  const override = process.env[AUTO_DETECT_BIN_ENV[runner]];
  if (override) return commandExists(override);
  return commandExistsOnPath(runner);
}

function commandExists(command: string): boolean {
  if (path.isAbsolute(command) || command.includes(path.sep)) return executableExists(command);
  return commandExistsOnPath(command);
}

function commandExistsOnPath(command: string): boolean {
  const pathValue = process.env.PATH;
  if (!pathValue) return false;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const executableName of executableNames(command)) {
      if (executableExists(path.join(dir, executableName))) return true;
    }
  }
  return false;
}

function executableExists(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return true;
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function executableNames(command: string): readonly string[] {
  if (process.platform !== "win32" || path.extname(command)) return [command];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((ext: string) => ext);
  return [command, ...extensions.map((ext: string) => `${command}${ext}`)];
}
