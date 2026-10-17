import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, statSync, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { ConnectionsDocumentError, connectionsFile, targetRoot, validateConnectionsDocument, resolveConnectionRoutes, type Connection } from "../shared/connections.js";
import { runLocal } from "./local.js";
import { initializeTempLifecycle } from "../shared/temp-lifecycle.js";
import { resolveRunnerBinary, runnerReviewCapability } from "../shared/runner-detection.js";

export type ConnectionsOperation = "list" | "edit" | "validate" | "apply" | "inspect" | "review";
type ErrorCode = "invalid_request" | "input_too_large" | "input_timeout" | "invalid_configuration" | "unsafe_configuration" | "configuration_unavailable" | "revision_conflict" | "config_busy" | "save_failed" | "save_state_unknown" | "cancelled" | "review_incomplete";
export class ConnectionsError extends Error {
  constructor(readonly code: ErrorCode, readonly issues?: readonly { readonly field: string; readonly code: string }[]) { super(code); }
}
const MAX_DOCUMENT = 65536;
const MISSING = "missing";
const fail = (code: ErrorCode): never => { throw new ConnectionsError(code); };
const hasCode = (error: unknown, code: string): boolean => error instanceof Error && "code" in error && error.code === code;
function object(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("invalid_request");
  return raw as Record<string, unknown>;
}
function keys(raw: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(raw).length !== expected.length || expected.some(key => !Object.hasOwn(raw, key))) fail("invalid_request");
}
function validate(raw: unknown) {
  try { return validateConnectionsDocument(raw); }
  catch (error) {
    throw new ConnectionsError("invalid_configuration", error instanceof ConnectionsDocumentError ? [{ field: error.field, code: error.issueCode }] : undefined);
  }
}
function descriptors(connections: readonly Connection[]) {
  return connections.map(connection => ({
    id: connection.id, adapter: connection.adapter, requestedModel: connection.model ?? null,
    route: connection.auth?.kind === "codex-env" ? connection.auth.route.kind : connection.adapter === "acp" ? "opaque" : "ambient",
    credentialSource: connection.auth ? "reference-configured" : "ambient",
    providerAccount: "unknown", authentication: "unknown", readiness: "unknown", qualification: "unqualified",
  }));
}
const revision = (bytes: Buffer): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
function cancelled(signal?: AbortSignal): void { if (signal?.aborted) fail("cancelled"); }

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try { await handle.sync(); } finally { await handle.close(); }
}

async function safeAncestors(directory: string): Promise<void> {
  for (let current = directory; ; current = path.dirname(current)) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.uid !== 0 && stat.uid !== process.getuid?.())
      || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) fail("unsafe_configuration");
    if (path.dirname(current) === current) return;
  }
}

async function location(repo: string, env: NodeJS.ProcessEnv) {
  let file: string;
  try { file = connectionsFile(env); } catch { return fail("unsafe_configuration"); }
  if ([".", ".."].includes(path.basename(file)) || file.endsWith(path.sep)) return fail("unsafe_configuration");
  const suppliedParent = path.dirname(file);
  try {
    const stat = await fs.lstat(suppliedParent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) return fail("unsafe_configuration");
    const parent = await fs.realpath(suppliedParent);
    await safeAncestors(parent);
    const canonical = path.join(parent, path.basename(file));
    const relative = path.relative(targetRoot(repo), canonical);
    if (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)) return fail("unsafe_configuration");
    return { file: canonical, parent, identity: { dev: stat.dev, ino: stat.ino } };
  } catch (error) {
    if (error instanceof ConnectionsError) throw error;
    return fail("configuration_unavailable");
  }
}
type Location = Awaited<ReturnType<typeof location>>;
async function stableParent(loc: Location): Promise<void> {
  await safeAncestors(loc.parent);
  const stat = await fs.lstat(loc.parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== loc.identity.dev || stat.ino !== loc.identity.ino
    || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("unsafe_configuration");
}
async function snapshot(loc: Location) {
  await stableParent(loc);
  let handle;
  try { handle = await fs.open(loc.file, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0)); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return { revision: MISSING, parsed: validate({ version: 1, connections: [] }) };
    if (hasCode(error, "ELOOP")) return fail("unsafe_configuration");
    return fail("configuration_unavailable");
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("unsafe_configuration");
    const bytes = Buffer.alloc(MAX_DOCUMENT + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > MAX_DOCUMENT) fail("invalid_configuration");
    let raw: unknown;
    try { raw = JSON.parse(bytes.subarray(0, length).toString("utf8")); } catch { return fail("invalid_configuration"); }
    return { revision: revision(bytes.subarray(0, length)), parsed: validate(raw) };
  } finally { await handle.close(); }
}

async function apply(repo: string, env: NodeJS.ProcessEnv, raw: Record<string, unknown>, signal?: AbortSignal) {
  keys(raw, ["expectedRevision", "document"]);
  if (typeof raw.expectedRevision !== "string" || (raw.expectedRevision !== MISSING && !/^sha256:[a-f0-9]{64}$/.test(raw.expectedRevision))) fail("invalid_request");
  const parsed = validate(raw.document);
  const bytes = Buffer.from(JSON.stringify(parsed.document) + "\n");
  if (bytes.length > MAX_DOCUMENT) fail("invalid_configuration");
  cancelled(signal);
  const loc = await location(repo, env);
  cancelled(signal);
  const lockPath = `${loc.file}.lock`;
  let lock;
  try { lock = await fs.open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600); }
  catch (error) { return fail(hasCode(error, "EEXIST") ? "config_busy" : "save_failed"); }
  let lockIdentity: Stats | undefined;
  let temporary: string | undefined;
  let committed = false;
  try {
    lockIdentity = await lock.stat();
    if ((await snapshot(loc)).revision !== raw.expectedRevision) fail("revision_conflict");
    cancelled(signal);
    temporary = path.join(loc.parent, `.connections-${randomUUID()}.tmp`);
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    cancelled(signal);
    // External editors do not honor this lock; this final check is best effort.
    if ((await snapshot(loc)).revision !== raw.expectedRevision) fail("revision_conflict");
    await stableParent(loc);
    cancelled(signal);
    await fs.rename(temporary, loc.file);
    committed = true;
    temporary = undefined;
    await syncDirectory(loc.parent);
    return { schemaVersion: 1, ok: true, revision: revision(bytes), connections: descriptors(parsed.connections) };
  } catch (error) {
    if (committed) return fail("save_state_unknown");
    if (error instanceof ConnectionsError) throw error;
    return fail("save_failed");
  } finally {
    try {
      try { if (temporary) await fs.unlink(temporary); }
      finally {
        try { await lock.close(); } finally {
          if (lockIdentity) {
            const currentLock = await fs.lstat(lockPath);
            if (currentLock.dev !== lockIdentity.dev || currentLock.ino !== lockIdentity.ino) fail(committed ? "save_state_unknown" : "save_failed");
            await fs.unlink(lockPath);
            await syncDirectory(loc.parent);
          }
        }
      }
    } catch { fail(committed ? "save_state_unknown" : "save_failed"); }
  }
}

export async function runConnections(operation: Exclude<ConnectionsOperation, "review">, repo: string, request: unknown = undefined,
  env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
  try {
    cancelled(signal);
    if (operation === "validate") {
      const raw = object(request); keys(raw, ["document"]);
      const parsed = validate(raw.document);
      if (Buffer.byteLength(JSON.stringify(parsed.document)) + 1 > MAX_DOCUMENT) fail("invalid_configuration");
      return { schemaVersion: 1, ok: true, connections: descriptors(parsed.connections) };
    }
    if (operation === "apply") return await apply(repo, env, object(request), signal);
    const loc = await location(repo, env);
    cancelled(signal);
    const current = await snapshot(loc);
    cancelled(signal);
    if (operation === "edit") return { schemaVersion: 1, ok: true, baseRevision: current.revision, document: current.parsed.document };
    if (operation === "list") return { schemaVersion: 1, ok: true, revision: current.revision, connections: descriptors(current.parsed.connections) };
    const raw = object(request); keys(raw, ["ids"]);
    const ids = raw.ids;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id): id is string => typeof id === "string") || new Set(ids).size !== ids.length) return fail("invalid_request");
    const selected = ids.map(id => {
      const found = current.parsed.connections.find(connection => connection.id === id);
      if (!found) return fail("invalid_request");
      return found;
    });
    const rows = descriptors(selected).map((descriptor, index) => {
      const connection = selected[index];
      let available: boolean;
      if (connection.launch) {
        try { accessSync(connection.launch.command, constants.X_OK); available = statSync(connection.launch.command).isFile(); } catch { available = false; }
      } else available = resolveRunnerBinary(connection.adapter)?.path !== undefined;
      return { ...descriptor, readiness: available && runnerReviewCapability(connection.adapter).capability !== "promptOnly" ? "local-available" : "local-blocked" };
    });
    return { schemaVersion: 1, ok: true, revision: current.revision, connections: rows };
  } catch (error) {
    return { schemaVersion: 1, ok: false, code: error instanceof ConnectionsError ? error.code : "configuration_unavailable",
      ...(error instanceof ConnectionsError && error.issues ? { issues: error.issues } : {}) };
  }
}

type SessionReviewRequest = {
  readonly repo: string;
  readonly expectedRevision: string;
  readonly ids: readonly string[];
  readonly budgetMs: number;
  readonly credentials: { readonly kind: "existing" } | { readonly kind: "session"; readonly sources: Readonly<Record<string, string>> };
};

function parseReviewRequest(request: unknown): SessionReviewRequest {
  const raw = object(request);
  keys(raw, ["repo", "scope", "expectedRevision", "ids", "budgetMs", "credentialMode", "sources"]);
  if (typeof raw.repo !== "string" || !path.isAbsolute(raw.repo) || raw.repo.includes("\0")
    || raw.scope !== "local-uncommitted" || typeof raw.expectedRevision !== "string" || !/^sha256:[a-f0-9]{64}$/.test(raw.expectedRevision)
    || !Array.isArray(raw.ids) || !raw.ids.length || !raw.ids.every((id): id is string => typeof id === "string" && !!id.trim() && id === id.trim())
    || new Set(raw.ids).size !== raw.ids.length || typeof raw.budgetMs !== "number" || !Number.isSafeInteger(raw.budgetMs)
    || raw.budgetMs < 1 || raw.budgetMs > 2147483647) return fail("invalid_request");
  const sources = object(raw.sources);
  let credentials: SessionReviewRequest["credentials"];
  if (raw.credentialMode === "existing") {
    keys(sources, []);
    credentials = { kind: "existing" };
  } else if (raw.credentialMode === "session") {
    credentials = { kind: "session", sources: Object.fromEntries(Object.entries(sources).map(([name, value]) => {
      if (typeof value !== "string") return fail("invalid_request");
      return [name, value];
    })) };
  } else return fail("invalid_request");
  return { repo: raw.repo, expectedRevision: raw.expectedRevision, ids: [...raw.ids], budgetMs: raw.budgetMs, credentials };
}

async function prepareSessionReview(request: unknown, env: NodeJS.ProcessEnv, signal?: AbortSignal) {
  const parsed = parseReviewRequest(request);
  cancelled(signal);
  const current = await snapshot(await location(parsed.repo, env));
  cancelled(signal);
  if (current.revision !== parsed.expectedRevision) fail("revision_conflict");
  const selected = parsed.ids.map(id => current.parsed.connections.find(connection => connection.id === id) ?? fail("invalid_request"));
  let localEnv = env;
  if (parsed.credentials.kind === "session") {
    if (selected.some(connection => !connection.auth)) return fail("invalid_request");
    const refs = [...new Set(selected.flatMap(connection => connection.auth ? Object.values(connection.auth.env) : []))];
    keys(parsed.credentials.sources, refs);
    localEnv = { ...env, ...parsed.credentials.sources };
  }
  const opts = { localMode: "uncommitted" as const, connections: parsed.ids, reviewBudgetMs: parsed.budgetMs };
  const routes = resolveConnectionRoutes(opts, parsed.repo, localEnv, true, { connections: current.parsed.connections, encodedOutputGuard: true });
  cancelled(signal);
  return { repo: parsed.repo, opts, routes };
}

export async function runConnectionsReview(request: unknown, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal) {
  try {
    const prepared = await prepareSessionReview(request, env, signal);
    request = undefined;
    cancelled(signal);
    await initializeTempLifecycle();
    return await runLocal(prepared.repo, prepared.opts, undefined, { routes: prepared.routes, signal });
  } catch (error) {
    return { schemaVersion: 1, ok: false, code: signal?.aborted ? "cancelled" : error instanceof ConnectionsError ? error.code : "review_incomplete" };
  }
}

export async function readConnectionsRequest(input: Readable, signal?: AbortSignal, timeoutMs = 5000, rejectDuplicates = false): Promise<unknown> {
  if ("isTTY" in input && input.isTTY) return fail("invalid_request");
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (error?: ConnectionsError) => {
      clearTimeout(timer);
      input.off("data", data); input.off("end", end); input.off("error", inputError);
      signal?.removeEventListener("abort", abort);
      input.pause();
      if (error) { for (const chunk of chunks) chunk.fill(0); reject(error); return; }
      const bytes = Buffer.concat(chunks);
      try {
        const text = bytes.toString("utf8");
        const request: unknown = JSON.parse(text);
        if (rejectDuplicates) {
          const containers: (Set<string> | null)[] = [];
          for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}[\]]/g)) {
            const token = match[0];
            if (token === "{") containers.push(new Set());
            else if (token === "[") containers.push(null);
            else if (token === "}" || token === "]") containers.pop();
            else if (/^\s*:/.test(text.slice(match.index + token.length))) {
              const name: unknown = JSON.parse(token);
              const names = containers.at(-1);
              if (typeof name !== "string" || !names || names.has(name)) return fail("invalid_request");
              names.add(name);
            }
          }
        }
        resolve(request);
      } catch { reject(new ConnectionsError("invalid_request")); }
      finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > 131072) { bytes.fill(0); finish(new ConnectionsError("input_too_large")); return; }
      chunks.push(bytes);
    };
    const end = () => finish();
    const inputError = () => finish(new ConnectionsError("invalid_request"));
    const abort = () => finish(new ConnectionsError("cancelled"));
    const timer = setTimeout(() => finish(new ConnectionsError("input_timeout")), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    input.on("data", data); input.once("end", end); input.once("error", inputError);
  });
}
