import { accessSync, constants } from "node:fs";
import path from "node:path";
import { RUNNER_DEFINITIONS as RUNNER_CATALOG } from "./runner-definition.js";
import { RUNNER_DEFINITIONS, parseRunnerName, type RunnerName, type RunnerOptions } from "./runner.js";

const AUTO_DETECT_RUNNERS = RUNNER_CATALOG.filter((runner) => "autoDetect" in runner);

export const NO_AUTO_DETECTED_RUNNER_MESSAGE = [
  "No supported model runner found on PATH.",
  "Install one:",
  ...AUTO_DETECT_RUNNERS.map(({ name, autoDetect }) => `  ${name}: ${autoDetect.installCommand}`),
].join("\n");

/** The command a CLI runner would be spawned as, and where on disk it resolved (undefined when not found). */
export interface ResolvedRunnerBinary {
  readonly command: string;
  readonly path: string | undefined;
}

export function resolveRunner(opts: RunnerOptions): RunnerName {
  if (opts.runner) return opts.runner;
  const envRunner = process.env.NEEDLEFISH_RUNNER;
  if (envRunner) return parseRunnerName(envRunner, "NEEDLEFISH_RUNNER");
  return autoDetectRunner();
}

function autoDetectRunner(): RunnerName {
  for (const runner of AUTO_DETECT_RUNNERS) {
    if (resolveRunnerBinary(runner.name)?.path !== undefined) return runner.name;
  }
  throw new Error(NO_AUTO_DETECTED_RUNNER_MESSAGE);
}

/**
 * The command runner R is spawned as. The `*_BIN` override is trimmed and a blank
 * value counts as unset; then the catalog default applies. Undefined when R has
 * no CLI (openai) or its override is required and unset (acp). Detection, the
 * doctor, and every spawn site read it here so they cannot disagree.
 */
export function runnerCommand(runner: RunnerName): string | undefined {
  const bin = RUNNER_DEFINITIONS[runner].bin;
  if (bin === undefined) return undefined;
  return process.env[bin.env]?.trim() || bin.fallback;
}

/** runnerCommand at a spawn site: a runner with no command is an error naming what to set. */
export function requireRunnerCommand(runner: RunnerName): string {
  const command = runnerCommand(runner);
  if (command !== undefined) return command;
  const bin = RUNNER_DEFINITIONS[runner].bin;
  throw new Error(
    bin === undefined ? `${runner} runner has no CLI to spawn` : `${bin.env} is required for the ${runner} runner`,
  );
}

/** Undefined when the runner has no executable to resolve: an HTTP runner, or a bin env that is required but unset. */
export function resolveRunnerBinary(runner: RunnerName): ResolvedRunnerBinary | undefined {
  const command = runnerCommand(runner);
  if (command === undefined) return undefined;
  if (path.isAbsolute(command) || command.includes(path.sep)) {
    return { command, path: executableExists(command) ? command : undefined };
  }
  return { command, path: findOnPath(command) };
}

function findOnPath(command: string): string | undefined {
  const pathValue = process.env.PATH;
  if (!pathValue) return undefined;
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const executableName of executableNames(command)) {
      const candidate = path.join(dir, executableName);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
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
