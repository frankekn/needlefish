import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AcpEnvironmentAuth, CodexEnvironmentAuth, parseAuthEnvironment, parseCodexAuthEnvironment, parseCodexRoute, type CodexAuthRoute, type AuthEnvironmentReferences } from "./connection-auth.js";
import { isRunnerName, type AcpLaunchSpec, type RunnerName, type RunnerOptions } from "./runner.js";

// User/operator configuration, never model output or target-repo policy.
// ACP and explicit Codex environment credential references are supported.
// OAuth profiles remain a separate increment.
type ConnectionAuthSpec =
  | { readonly kind: "acp-env"; readonly env: AuthEnvironmentReferences }
  | { readonly kind: "codex-env"; readonly env: AuthEnvironmentReferences; readonly route: CodexAuthRoute };

export interface Connection {
  readonly id: string;
  readonly adapter: RunnerName;
  readonly model?: string;
  readonly launch?: AcpLaunchSpec;
  readonly auth?: ConnectionAuthSpec;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid connections configuration: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new Error(`Invalid connections configuration: unsupported field in ${label}. OAuth profiles are not supported in this version.`);
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
    onlyKeys(entry, ["id", "adapter", "model", "launch", "auth"], "connection");
    const id = text(entry.id, "id");
    if (ids.has(id)) throw new Error("Invalid connections configuration: duplicate connection id.");
    ids.add(id);
    const adapter = text(entry.adapter, "adapter");
    if (!isRunnerName(adapter)) throw new Error("Unknown connection adapter. Use an existing CLI adapter or acp for a custom agent.");
    let auth: Connection["auth"];
    if (entry.auth !== undefined) {
      if (adapter !== "acp" && adapter !== "codex") throw new Error("Connection auth is supported only by the acp and codex adapters.");
      const spec = record(entry.auth, "auth");
      onlyKeys(spec, adapter === "codex" ? ["env", "route"] : ["env"], "auth");
      if (adapter === "codex") {
        const route = parseCodexRoute(spec.route);
        auth = Object.freeze({ kind: "codex-env", env: parseCodexAuthEnvironment(spec.env, route), route });
      } else auth = Object.freeze({ kind: "acp-env", env: parseAuthEnvironment(spec.env) });
    }
    const model = entry.model === undefined ? undefined : text(entry.model, "model");
    let launch: AcpLaunchSpec | undefined;
    if (adapter === "acp") {
      launch = parseAcpLaunch(entry.launch, model);
    } else {
      if (entry.launch !== undefined) throw new Error("launch is only supported by the acp adapter.");
      if (model === undefined) throw new Error("Set a model for a named CLI connection; ambient model settings are not inherited.");
    }
    return Object.freeze({ id, adapter, ...(model === undefined ? {} : { model }), ...(launch ? { launch } : {}), ...(auth ? { auth } : {}) });
  }));
}

function parseAcpLaunch(raw: unknown, model: string | undefined): AcpLaunchSpec {
  const spec = record(raw, "ACP launch");
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
  return Object.freeze({ command, args: Object.freeze(args.map((arg) => arg === "{model}" ? model! : arg)) });
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

export function resolveConnectionRoutes<T extends RunnerOptions>(
  opts: T, repoPath: string, env: NodeJS.ProcessEnv = process.env, bindCredentials = true,
): readonly [T, ...T[]] {
  if (opts.connections === undefined) return [opts];
  const [first, ...rest] = opts.connections;
  if (first === undefined) throw new Error("Select at least one connection.");
  for (const id of opts.connections) text(id, "selected connection");
  if (new Set(opts.connections).size !== opts.connections.length) throw new Error("Selected connection IDs must not repeat.");
  if (opts.runner !== undefined || opts.model !== undefined || opts.acpLaunch !== undefined || opts.connectionAuth !== undefined) {
    throw new Error("--connection cannot be combined with --runner, --model or separate ACP launch/auth.");
  }
  const connections = readConnections(connectionsFile(env), repoPath);
  const select = (id: string): Connection => {
    const connection = connections.find(entry => entry.id === id);
    if (!connection) throw new Error("Selected connection was not found. Check --connection against your user connections.json.");
    return connection;
  };
  const selected: readonly [Connection, ...Connection[]] = [select(first), ...rest.map(select)];
  const resolve = (connection: Connection): T => {
    const connectionAuth = connection.auth && bindCredentials
      ? connection.auth.kind === "codex-env" ? new CodexEnvironmentAuth(connection.auth.env, connection.auth.route, env) : new AcpEnvironmentAuth(connection.auth.env, env)
      : undefined;
    connectionAuth?.assertCompatible(connection.adapter, env);
    return Object.freeze({
      ...opts, connections: Object.freeze([connection.id]), runner: connection.adapter,
      ...(connection.model === undefined ? {} : { model: connection.model }),
      ...(connection.launch ? { acpLaunch: connection.launch } : {}),
      ...(connectionAuth ? { connectionAuth } : {}),
    });
  };
  return Object.freeze([resolve(selected[0]), ...selected.slice(1).map(resolve)]);
}

export function resolveConnectionOptions<T extends RunnerOptions>(
  opts: T, repoPath: string, env: NodeJS.ProcessEnv = process.env, bindCredentials = true,
): T {
  if ((opts.connections?.length ?? 0) > 1) throw new Error("This command accepts only one --connection; use a whole review for ordered fallback.");
  return resolveConnectionRoutes(opts, repoPath, env, bindCredentials)[0];
}
