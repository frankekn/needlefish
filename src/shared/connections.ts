import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRunnerName, type AcpLaunchSpec, type RunnerName, type RunnerOptions } from "./runner.js";

// User/operator configuration, never model output or target-repo policy.
// Credentials, per-account homes, presets and fallback are deliberately not
// accepted yet: silently ignoring those fields would misrepresent isolation.
export interface Connection {
  readonly id: string;
  readonly adapter: RunnerName;
  readonly model?: string;
  readonly launch?: AcpLaunchSpec;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid connections configuration: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Invalid connections configuration: unsupported field in ${label}. Account profiles and fallback are not supported in this version.`);
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    throw new Error(`Invalid connections configuration: ${label} must be non-empty text without control characters or surrounding whitespace.`);
  }
  return value;
}

export function parseConnections(raw: unknown): readonly Connection[] {
  const config = record(raw, "root");
  onlyKeys(config, ["version", "connections"], "root");
  if (config.version !== 1 || !Array.isArray(config.connections)) {
    throw new Error("Invalid connections configuration: expected version 1 and a connections array.");
  }
  const ids = new Set<string>();
  return Object.freeze(config.connections.map((value): Connection => {
    const entry = record(value, "connection");
    onlyKeys(entry, ["id", "adapter", "model", "launch"], "connection");
    const id = text(entry.id, "id");
    if (ids.has(id)) throw new Error("Invalid connections configuration: duplicate connection id.");
    ids.add(id);
    const adapter = text(entry.adapter, "adapter");
    if (!isRunnerName(adapter)) throw new Error("Unknown connection adapter. Use an existing CLI adapter or acp for a custom agent.");
    const model = entry.model === undefined ? undefined : text(entry.model, "model");
    let launch: AcpLaunchSpec | undefined;
    if (adapter === "acp") {
      const spec = record(entry.launch, "ACP launch");
      onlyKeys(spec, ["command", "args"], "ACP launch");
      const command = text(spec.command, "ACP command");
      if (!path.isAbsolute(command)) throw new Error("ACP command must be an absolute executable path, not a shell command.");
      if (!Array.isArray(spec.args) || !spec.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) {
        throw new Error("ACP args must be an array of strings without NUL bytes.");
      }
      const args = spec.args as string[];
      const slots = args.filter((arg) => arg === "{model}").length;
      if (args.some((arg) => arg.includes("{model}") && arg !== "{model}") || slots !== (model === undefined ? 0 : 1)) {
        throw new Error("ACP model selection requires exactly one whole {model} argument and a model; omit both to use the agent default.");
      }
      launch = Object.freeze({ command, args: Object.freeze(args.map((arg) => arg === "{model}" ? model! : arg)) });
    } else {
      if (entry.launch !== undefined) throw new Error("launch is only supported by the acp adapter.");
      if (model === undefined) throw new Error("Set a model for a named CLI connection; ambient model settings are not inherited.");
    }
    return Object.freeze({ id, adapter, ...(model === undefined ? {} : { model }), ...(launch ? { launch } : {}) });
  }));
}

export function connectionsFile(env: NodeJS.ProcessEnv = process.env): string {
  const file = env.NEEDLEFISH_CONNECTIONS_FILE ?? path.join(
    env.XDG_CONFIG_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), ".config"),
    "needlefish", "connections.json",
  );
  if (!path.isAbsolute(file)) throw new Error("Connections file must be an absolute path. Set NEEDLEFISH_CONNECTIONS_FILE to a user-owned file outside the reviewed repository.");
  return file;
}

function targetRoot(repoPath: string): string {
  const start = realpathSync(repoPath);
  // Cover invocation from a project subdirectory, including Git worktrees
  // whose .git is a file. This is only a conservative config trust check;
  // the existing adapters still own actual Git/review scope discovery.
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (path.dirname(dir) === dir) return start;
  }
}

function readConnections(file: string, repoPath: string): readonly Connection[] {
  let canonical: string;
  try { canonical = realpathSync(file); } catch {
    throw new Error("Connections file is unavailable. Create the user connections.json or set NEEDLEFISH_CONNECTIONS_FILE to its absolute path.");
  }
  const relative = path.relative(targetRoot(repoPath), canonical);
  if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
    throw new Error("Connections file must be outside the reviewed repository, including symlink targets.");
  }
  const fd = openSync(canonical, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  let raw: unknown;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Connections file must be a regular file.");
    // Bound the actual read, not only a stat that may race a growing file.
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const n = readSync(fd, buffer, length, buffer.length - length, null);
      if (n === 0) break;
      length += n;
    }
    if (length > 65536) throw new Error("Connections file exceeds 64 KiB.");
    try { raw = JSON.parse(buffer.subarray(0, length).toString("utf8")); } catch {
      // JSON parser errors may quote credentials accidentally put in the file.
      throw new Error("Connections file is not valid JSON. Check its syntax; do not store credentials in it.");
    }
  } finally { closeSync(fd); }
  return parseConnections(raw);
}

// Resolve once at the CLI boundary. No process.env mutation, subprocesses,
// authentication probes, or automatic provider switching. Legacy calls do
// not even open the config file. The returned selection is fixed for all passes.
export function resolveConnectionOptions<T extends RunnerOptions>(
  opts: T, repoPath: string, env: NodeJS.ProcessEnv = process.env,
): T {
  if (opts.connection === undefined) return opts;
  text(opts.connection, "selected connection");
  if (opts.runner !== undefined || opts.model !== undefined || opts.acpLaunch !== undefined) {
    throw new Error("--connection cannot be combined with --runner, --model or a separate ACP launch.");
  }
  const selected = readConnections(connectionsFile(env), repoPath).find((entry) => entry.id === opts.connection);
  if (!selected) throw new Error("Selected connection was not found. Check --connection against your user connections.json.");
  return Object.freeze({
    ...opts, runner: selected.adapter,
    ...(selected.model === undefined ? {} : { model: selected.model }),
    ...(selected.launch ? { acpLaunch: selected.launch } : {}),
  });
}
