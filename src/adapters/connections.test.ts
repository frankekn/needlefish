import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { test } from "node:test";
import { readConnectionsRequest, runConnections } from "./connections.js";
import { parseConnections, validateConnectionsDocument } from "../shared/connections.js";

const document = { version: 1, connections: [{ id: "custom", adapter: "acp", model: "fake-model", launch: { command: "/fake/agent", args: ["--model", "{model}", "$(touch /fake/never)"] }, auth: { env: { API_KEY: "FAKE_SOURCE" } } }] };
const changed = { version: 1, connections: [{ id: "second", adapter: "codex", model: "fake-model", auth: { env: { CODEX_API_KEY: "FAKE_SOURCE" }, route: { kind: "openai" } } }] };
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "nf-connections-editor-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo"), config = path.join(root, "config");
  await fs.mkdir(repo); await fs.mkdir(config, { mode: 0o700 });
  await fs.mkdir(path.join(repo, ".git"));
  const file = path.join(config, "connections.json");
  const env = { NEEDLEFISH_CONNECTIONS_FILE: file };
  const run = (operation: Parameters<typeof runConnections>[0], request?: unknown, signal?: AbortSignal) => runConnections(operation, repo, request, env, signal);
  return { root, repo, config, file, env, run };
}
function success<T extends { ok: boolean }>(result: T): T { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function error(result: unknown, code: string) {
  assert.ok(result && typeof result === "object" && "schemaVersion" in result && "ok" in result && "code" in result);
  assert.deepEqual({ schemaVersion: result.schemaVersion, ok: result.ok, code: result.code }, { schemaVersion: 1, ok: false, code });
}

test("one parser retains raw ACP placeholder and strips only internal auth.kind", () => {
  const parsed = validateConnectionsDocument(document);
  assert.deepEqual(parsed.document, document);
  assert.deepEqual(parsed.connections[0].launch?.args, ["--model", "fake-model", "$(touch /fake/never)"]);
  assert.equal(parsed.connections[0].auth?.kind, "acp-env");
  assert.deepEqual(parseConnections(parsed.document), parsed.connections);
  assert.throws(() => parseConnections({ version: 1, connections: parsed.connections }));
});

test("missing, create, edit, ordered inspect, replace and delete preserve raw schema", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.run("list"), { schemaVersion: 1, ok: true, revision: "missing", connections: [] });
  const saved = success(await f.run("apply", { expectedRevision: "missing", document }));
  assert.ok("revision" in saved);
  const revision = saved.revision;
  assert.equal((await fs.stat(f.file)).mode & 0o777, 0o600);
  assert.deepEqual(await f.run("edit"), { schemaVersion: 1, ok: true, baseRevision: revision, document });
  assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(document) + "\n");
  const catalog = success(await f.run("inspect", { ids: ["custom"] }));
  assert.ok("connections" in catalog);
  assert.deepEqual(catalog.connections, [{ id: "custom", adapter: "acp", requestedModel: "fake-model", route: "opaque", credentialSource: "reference-configured", providerAccount: "unknown", authentication: "unknown", readiness: "local-blocked", qualification: "unqualified" }]);
  assert.ok(!JSON.stringify(catalog).includes("FAKE_SOURCE"));
  const replaced = success(await f.run("apply", { expectedRevision: revision, document: changed }));
  assert.ok("revision" in replaced);
  const empty = success(await f.run("apply", { expectedRevision: replaced.revision, document: { version: 1, connections: [] } }));
  assert.ok("connections" in empty);
  assert.deepEqual(empty.connections, []);
  error(await f.run("inspect", { ids: ["custom"] }), "invalid_request");
});

test("exact byte revisions reject stale drafts and cooperative concurrent writers", async t => {
  const f = await fixture(t);
  const first = success(await f.run("apply", { expectedRevision: "missing", document }));
  assert.ok("revision" in first);
  await fs.writeFile(f.file, JSON.stringify(document, null, 2));
  error(await f.run("apply", { expectedRevision: first.revision, document: changed }), "revision_conflict");
  const edit = success(await f.run("edit")); assert.ok("baseRevision" in edit);
  const results = await Promise.all([f.run("apply", { expectedRevision: edit.baseRevision, document: changed }), f.run("apply", { expectedRevision: edit.baseRevision, document: { version: 1, connections: [] } })]);
  assert.equal(results.filter(row => row.ok).length, 1);
  assert.ok(results.some(row => !row.ok && "code" in row && (row.code === "config_busy" || row.code === "revision_conflict")));
  assert.deepEqual((await fs.readdir(f.config)).sort(), ["connections.json"]);
});

test("invalid drafts and invalid existing files preserve original bytes without echo", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "{accidental-fake-private-text", { mode: 0o600 });
  for (const operation of ["list", "edit", "apply"] as const) {
    error(await f.run(operation, { expectedRevision: "missing", document }), "invalid_configuration");
    assert.equal(await fs.readFile(f.file, "utf8"), "{accidental-fake-private-text");
  }
  assert.deepEqual(await f.run("validate", { document: { ...document, fallback: "fake-private-text" } }), { schemaVersion: 1, ok: false, code: "invalid_configuration", issues: [{ field: "root", code: "unsupported_field" }] });
  error(await f.run("validate", { document: { version: 1, connections: [{ id: "huge", adapter: "codex", model: "a".repeat(65536) }] } }), "invalid_configuration");
  await fs.writeFile(f.file, "a".repeat(65537));
  error(await f.run("edit"), "invalid_configuration");
});

test("in-repo, symlink, hardlink and unsafe parent configurations cannot be edited", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.file, JSON.stringify(document), { mode: 0o600 });
  const link = path.join(f.config, "linked.json");
  await fs.symlink(f.file, link);
  error(await runConnections("edit", f.repo, undefined, { NEEDLEFISH_CONNECTIONS_FILE: link }), "unsafe_configuration");
  const hard = path.join(f.config, "hard.json"); await fs.link(f.file, hard);
  error(await f.run("edit"), "unsafe_configuration"); await fs.unlink(hard);
  error(await runConnections("apply", f.repo, { expectedRevision: "missing", document }, { NEEDLEFISH_CONNECTIONS_FILE: path.join(f.repo, "connections.json") }), "unsafe_configuration");
  const parentLink = path.join(f.root, "parent-link"); await fs.symlink(f.config, parentLink);
  error(await runConnections("edit", f.repo, undefined, { NEEDLEFISH_CONNECTIONS_FILE: path.join(parentLink, "connections.json") }), "unsafe_configuration");
  await fs.chmod(f.config, 0o777);
  error(await f.run("edit"), "unsafe_configuration");
});

test("existing lock is never removed, even when it looks stale", async t => {
  const f = await fixture(t);
  await fs.writeFile(`${f.file}.lock`, "stale fake owner", { mode: 0o600 });
  error(await f.run("apply", { expectedRevision: "missing", document }), "config_busy");
  assert.equal(await fs.readFile(`${f.file}.lock`, "utf8"), "stale fake owner");
  await assert.rejects(fs.stat(f.file), { code: "ENOENT" });
});

test("partial temp write and rename failure retain the original file and clean owned files", async t => {
  const f = await fixture(t);
  const saved = success(await f.run("apply", { expectedRevision: "missing", document })); assert.ok("revision" in saved);
  const original = await fs.readFile(f.file, "utf8");
  const open = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp")) t.mock.method(handle, "writeFile", async () => { await handle.write("partial"); throw new Error("fake write fault"); });
    return handle;
  });
  error(await f.run("apply", { expectedRevision: saved.revision, document: changed }), "save_failed");
  assert.equal(await fs.readFile(f.file, "utf8"), original);
  mocked.mock.restore();
  t.mock.method(fs, "rename", async () => { throw new Error("fake rename fault"); });
  error(await f.run("apply", { expectedRevision: saved.revision, document: changed }), "save_failed");
  assert.equal(await fs.readFile(f.file, "utf8"), original);
  assert.deepEqual(await fs.readdir(f.config), ["connections.json"]);
});

test("temp fsync failure preserves original and directory fsync failure reports unknown after commit", async t => {
  const f = await fixture(t);
  const saved = success(await f.run("apply", { expectedRevision: "missing", document })); assert.ok("revision" in saved);
  const open = fs.open;
  let directoryFault = false;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]) === f.config || !directoryFault && String(args[0]).endsWith(".tmp")) t.mock.method(handle, "sync", async () => { throw new Error("fake fsync fault"); });
    return handle;
  });
  error(await f.run("apply", { expectedRevision: saved.revision, document: changed }), "save_failed");
  assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(document) + "\n");
  directoryFault = true;
  error(await f.run("apply", { expectedRevision: saved.revision, document: changed }), "save_state_unknown");
  assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(changed) + "\n");
  assert.deepEqual(await fs.readdir(f.config), ["connections.json"]);
});

test("cancel before commit preserves original; cancel during successful rename reports saved", async t => {
  const f = await fixture(t);
  const saved = success(await f.run("apply", { expectedRevision: "missing", document })); assert.ok("revision" in saved);
  const controller = new AbortController();
  const open = fs.open;
  const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); controller.abort(); });
    }
    return handle;
  });
  error(await f.run("apply", { expectedRevision: saved.revision, document: changed }, controller.signal), "cancelled");
  assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(document) + "\n");
  mocked.mock.restore();
  const after = new AbortController(); const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { await rename(...args); after.abort(); });
  success(await f.run("apply", { expectedRevision: saved.revision, document: changed }, after.signal));
  assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(changed) + "\n");
});

test("external editor detected after temp fsync preserves its bytes", async t => {
  const f = await fixture(t);
  const saved = success(await f.run("apply", { expectedRevision: "missing", document })); assert.ok("revision" in saved);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp")) {
      const sync = handle.sync.bind(handle);
      t.mock.method(handle, "sync", async () => { await sync(); await fs.writeFile(f.file, JSON.stringify(document, null, 2)); });
    }
    return handle;
  });
  error(await f.run("apply", { expectedRevision: saved.revision, document: changed }), "revision_conflict");
  assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(document, null, 2));
});

test("stdin accepts bounded JSON and rejects size, syntax, timeout and cancellation", async () => {
  assert.deepEqual(await readConnectionsRequest(Readable.from([JSON.stringify({ document })])), { document });
  await assert.rejects(readConnectionsRequest(Readable.from(["a".repeat(131073)])), { message: "input_too_large" });
  await assert.rejects(readConnectionsRequest(Readable.from(["fake-private-invalid-json"])), { message: "invalid_request" });
  const idle = new PassThrough();
  await assert.rejects(readConnectionsRequest(idle, undefined, 10), { message: "input_timeout" }); idle.destroy();
  const input = new PassThrough(), controller = new AbortController();
  const pending = readConnectionsRequest(input, controller.signal); controller.abort();
  await assert.rejects(pending, { message: "cancelled" }); input.destroy();
});

test("real CLI machine operations never launch ACP version/login/model or echo invalid arguments", async t => {
  const f = await fixture(t);
  const executable = path.join(f.root, "fake-agent"); const marker = path.join(f.root, "never-started");
  await fs.writeFile(executable, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o700 });
  const ownDocument = { version: 1, connections: [{ id: "local", adapter: "acp", launch: { command: executable, args: ["literal"] } }] };
  const cli = (operation: string, input?: unknown, extra: string[] = []) => spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "connections", operation, "--json", "--repo", f.repo, ...extra], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: f.root, NEEDLEFISH_CONNECTIONS_FILE: f.file }, input: input === undefined ? undefined : JSON.stringify(input), encoding: "utf8", timeout: 15000 });
  const save = cli("apply", { expectedRevision: "missing", document: ownDocument });
  assert.equal(save.status, 0, save.stderr); assert.equal(save.stderr, "");
  const inspect = cli("inspect", { ids: ["local"] }); assert.equal(inspect.status, 0, inspect.stderr);
  const output = JSON.parse(inspect.stdout); assert.equal(output.connections[0].readiness, "local-available"); assert.equal(output.connections[0].authentication, "unknown");
  await assert.rejects(fs.access(marker, constants.F_OK), { code: "ENOENT" });
  const invalid = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "connections", "validate", "--json"], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: f.root }, input: "invalid-fake-private-payload", encoding: "utf8", timeout: 15000 });
  assert.equal(invalid.status, 1); assert.equal(invalid.stderr, "");
  assert.deepEqual(JSON.parse(invalid.stdout), { schemaVersion: 1, ok: false, code: "invalid_request" });
  const bad = cli("list", undefined, ["--fake-private-argument"]);
  assert.equal(bad.status, 1); assert.equal(bad.stderr, "");
  assert.deepEqual(JSON.parse(bad.stdout), { schemaVersion: 1, ok: false, code: "invalid_request" });
});


test("missing configuration directories remain read-only until a valid first apply", async t => {
  const f = await fixture(t);
  const parent = path.join(f.config, "new", "needlefish");
  const env = { NEEDLEFISH_CONNECTIONS_FILE: path.join(parent, "connections.json") };
  assert.deepEqual(await runConnections("edit", f.repo, undefined, env), { schemaVersion: 1, ok: true, baseRevision: "missing", document: { version: 1, connections: [] } });
  error(await runConnections("apply", f.repo, { expectedRevision: "missing", document: null }, env), "invalid_configuration");
  await assert.rejects(fs.stat(parent), { code: "ENOENT" });
  success(await runConnections("apply", f.repo, { expectedRevision: "missing", document }, env));
  assert.equal((await fs.stat(parent)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(env.NEEDLEFISH_CONNECTIONS_FILE, "utf8"), JSON.stringify(document) + "\n");
});


test("Codex auth requires an explicit route and the validated raw route is unchanged", () => {
  const missingRoute = { version: 1, connections: [{ id: "direct", adapter: "codex", model: "fake-model", auth: { env: { CODEX_API_KEY: "FAKE_SOURCE" } } }] };
  assert.throws(() => parseConnections(missingRoute), /Codex auth requires an explicit openai or cliproxyapi route/);
  assert.deepEqual(validateConnectionsDocument(changed).document, changed);
});

test("read-only commands honor cancellation during actual configuration reads", async t => {
  const f = await fixture(t);
  success(await f.run("apply", { expectedRevision: "missing", document }));
  const open = fs.open;
  for (const operation of ["list", "edit", "inspect"] as const) {
    const controller = new AbortController();
    const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const handle = await open(...args);
      if (String(args[0]) === f.file) {
        const read = handle.read.bind(handle);
        t.mock.method(handle, "read", async (...params: Parameters<typeof handle.read>) => { const result = await read(...params); controller.abort(); return result; });
      }
      return handle;
    });
    error(await f.run(operation, operation === "inspect" ? { ids: ["custom"] } : undefined, controller.signal), "cancelled");
    mocked.mock.restore();
    assert.equal(await fs.readFile(f.file, "utf8"), JSON.stringify(document) + "\n");
  }
});


test("configuration paths reject non-sticky writable ancestors and permit trusted sticky ancestors", async t => {
  const f = await fixture(t);
  const shared = path.join(f.root, "shared"), owned = path.join(shared, "owned");
  await fs.mkdir(shared); await fs.mkdir(owned, { mode: 0o700 }); await fs.chmod(shared, 0o777);
  const file = path.join(owned, "connections.json"), env = { NEEDLEFISH_CONNECTIONS_FILE: file };
  error(await runConnections("apply", f.repo, { expectedRevision: "missing", document }, env), "unsafe_configuration");
  assert.deepEqual(await fs.readdir(owned), []);
  await fs.chmod(shared, 0o1777);
  success(await runConnections("apply", f.repo, { expectedRevision: "missing", document }, env));
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(document) + "\n");
  await fs.chmod(shared, 0o777);
  error(await runConnections("edit", f.repo, undefined, env), "unsafe_configuration");
  assert.equal(await fs.readFile(file, "utf8"), JSON.stringify(document) + "\n");
});
