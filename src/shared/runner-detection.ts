import { accessSync, constants } from "node:fs";
import path from "node:path";
import { parseRunnerName, type RunnerName, type RunnerOptions } from "./runner.js";
import { AUTO_DETECT_RUNNERS, RUNNER_CATALOG } from "./runner-catalog.js";

const NO_AUTO_DETECTED_RUNNER_MESSAGE = [
	"No supported model runner found on PATH.",
	"Install one:",
	...AUTO_DETECT_RUNNERS.map((runner) => {
		const npmPackage = RUNNER_CATALOG[runner].hostedInstall?.npmPackage;
		if (!npmPackage) throw new Error(`auto-detected runner has no install package: ${runner}`);
		return `  ${runner}: npm install -g ${npmPackage}`;
	}),
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

function runnerExists(runner: RunnerName): boolean {
	const entry = RUNNER_CATALOG[runner];
	const override = entry.binaryEnv ? process.env[entry.binaryEnv] : undefined;
	if (override) return commandExists(override);
	if (!entry.binary) return false;
	return commandExistsOnPath(entry.binary);
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
