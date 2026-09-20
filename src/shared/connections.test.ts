import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { connectionsFile, parseConnections, resolveConnectionOptions } from "./connections.js";
import { RUNNERS } from "./runner.js";

const command = path.join(path.parse(process.cwd()).root, "tools", "custom agent");
const cli = { id: "我的連線", adapter: "claude", model: "selected-model" };
const acp = { id: "any-brand", adapter: "acp", model: "custom-model", launch: { command, args: ["acp", "--model", "{model}"] } };
const config = (entries: unknown[] = [cli, acp]) => ({ version: 1, connections: entries });

function fixture(t: TestContext, raw: unknown = config()) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "needlefish-connections-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  mkdirSync(path.join(repo, "sub"), { recursive: true });
  mkdirSync(path.join(repo, ".git"));
  const file = path.join(dir, "connections.json");
  writeFileSync(file, JSON.stringify(raw));
  return { dir, repo, file, env: { NEEDLEFISH_CONNECTIONS_FILE: file } };
}

test("existing adapter metadata and arbitrary ACP identities need no new RunnerName", () => {
  for (const adapter of RUNNERS.filter((name) => name !== "acp")) {
    assert.equal(parseConnections(config([{ ...cli, adapter }]))[0].adapter, adapter);
  }
  const entry = parseConnections(config())[1];
  assert.equal(entry.id, "any-brand");
  assert.deepEqual(entry.launch, { command, args: ["acp", "--model", "custom-model"] });
  assert.ok(Object.isFrozen(entry.launch?.args));
});

test("ACP without a model uses an empty or fixed argv, not an invented model flag", () => {
  assert.deepEqual(parseConnections(config([{ id: "custom", adapter: "acp", launch: { command, args: [] } }]))[0].launch?.args, []);
});

const invalid: readonly [string, unknown][] = [
  ["null", null],
  ["wrong version", { ...config(), version: 2 }],
  ["not an array", { version: 1, connections: {} }],
  ["fallback not implemented", { ...config(), fallback: { enabled: true } }],
  ["duplicate IDs", config([cli, cli])],
  ["unknown adapter", config([{ ...cli, adapter: "new-brand" }])],
  ["empty id", config([{ ...cli, id: "" }])],
  ["control id", config([{ ...cli, id: "name\nmore" }])],
  ["surrounding spaces", config([{ ...cli, id: " name " }])],
  ["missing CLI model", config([{ id: "c", adapter: "codex" }])],
  ["non-string model", config([{ ...cli, model: 5 }])],
  ["unimplemented authRef", config([{ ...cli, authRef: "secret-account" }])],
  ["unimplemented env", config([{ ...cli, env: { TOKEN: "secret" } }])],
  ["launch on native adapter", config([{ ...cli, launch: acp.launch }])],
  ["missing ACP launch", config([{ id: "a", adapter: "acp" }])],
  ["relative executable", config([{ ...acp, launch: { command: "./agent", args: [] } }])],
  ["shell args string", config([{ ...acp, launch: { command, args: "acp --model x" } }])],
  ["non-string args", config([{ ...acp, launch: { command, args: [5] } }])],
  ["NUL arg", config([{ ...acp, launch: { command, args: ["\0"] } }])],
  ["model silently unused", config([{ ...acp, launch: { command, args: [] } }])],
  ["missing model for slot", config([{ id: "a", adapter: "acp", launch: acp.launch }])],
  ["duplicate model slot", config([{ ...acp, launch: { command, args: ["{model}", "{model}"] } }])],
  ["embedded model slot", config([{ ...acp, launch: { command, args: ["--model={model}"] } }])],
];
for (const [name, raw] of invalid) {
  test(`connection config rejects ${name}`, () => assert.throws(() => parseConnections(raw)));
}

test("legacy calls neither read config nor mutate their options", () => {
  const opts = { runner: "claude" as const, model: "legacy" };
  assert.equal(resolveConnectionOptions(opts, "missing", { NEEDLEFISH_CONNECTIONS_FILE: "invalid" }), opts);
});

test("selection is explicit, immutable, preserves local options and does not mutate ambient env", (t) => {
  const f = fixture(t);
  const env = { ...f.env, NEEDLEFISH_RUNNER: "codex", NEEDLEFISH_MODEL: "wrong-model" };
  const before = { ...env };
  const opts = { connection: "any-brand", deep: true, timeoutMs: 1234 };
  const resolved = resolveConnectionOptions(opts, f.repo, env);
  assert.deepEqual(resolved, { ...opts, runner: "acp", model: "custom-model", acpLaunch: { command, args: ["acp", "--model", "custom-model"] } });
  assert.ok(Object.isFrozen(resolved));
  writeFileSync(f.file, "invalid now");
  assert.equal(resolved.connection, "any-brand");
  assert.deepEqual(opts, { connection: "any-brand", deep: true, timeoutMs: 1234 });
  assert.deepEqual(env, before);
});

test("ACP agent default does not borrow an ambient requested model", (t) => {
  const f = fixture(t, config([{ id: "a", adapter: "acp", launch: { command, args: [] } }]));
  const resolved = resolveConnectionOptions({ connection: "a", model: undefined }, f.repo, { ...f.env, NEEDLEFISH_MODEL: "wrong" });
  assert.equal(resolved.model, undefined);
});

test("unknown selection never falls back to the first entry", (t) => {
  const f = fixture(t);
  assert.throws(() => resolveConnectionOptions({ connection: "missing" }, f.repo, f.env), /not found/);
});

test("conflicting explicit options are rejected before file access", () => {
  for (const extra of [{ runner: "codex" as const }, { model: "other" }, { acpLaunch: { command, args: [] } }]) {
    assert.throws(() => resolveConnectionOptions({ connection: "a", ...extra }, "missing", {}), /cannot be combined/);
  }
});

test("only user XDG/HOME or explicit absolute paths are used", (t) => {
  const f = fixture(t);
  assert.equal(connectionsFile({ XDG_CONFIG_HOME: f.dir }), path.join(f.dir, "needlefish", "connections.json"));
  assert.equal(connectionsFile({ HOME: f.dir }), path.join(f.dir, ".config", "needlefish", "connections.json"));
  assert.equal(connectionsFile(f.env), f.file);
  assert.throws(() => connectionsFile({ NEEDLEFISH_CONNECTIONS_FILE: "./connections.json" }), /absolute/);
  assert.throws(() => connectionsFile({ XDG_CONFIG_HOME: "relative" }), /absolute/);
});

test("repository config is rejected even from a nested working directory", (t) => {
  const f = fixture(t);
  const inside = path.join(f.repo, "connections.json");
  writeFileSync(inside, JSON.stringify(config()));
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, path.join(f.repo, "sub"), { NEEDLEFISH_CONNECTIONS_FILE: inside }), /outside the reviewed repository/);
});

test("a user-path symlink cannot redirect config into the target repo", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const inside = path.join(f.repo, "connections.json");
  writeFileSync(inside, JSON.stringify(config()));
  rmSync(f.file);
  symlinkSync(inside, f.file);
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /symlink targets/);
});

test("bad JSON diagnostics never echo configuration bytes", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, '{"token":"TEST_SECRET_DO_NOT_PRINT", BROKEN');
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /not valid JSON/);
    assert.doesNotMatch(error.message, /TEST_SECRET|BROKEN/);
    return true;
  });
});

test("missing, oversized and non-regular files fail clearly", (t) => {
  const f = fixture(t);
  writeFileSync(f.file, " ".repeat(65537));
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /64 KiB/);
  rmSync(f.file);
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /unavailable/);
  mkdirSync(f.file);
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /regular file/);
});

test("FIFO configuration cannot block the process", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  rmSync(f.file);
  assert.equal(spawnSync("mkfifo", [f.file]).status, 0);
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /regular file/);
});

test("parsed connections are frozen copies without freezing caller-owned input", () => {
  const input = structuredClone(config());
  const before = structuredClone(input);
  const parsed = parseConnections(input);
  assert.deepEqual(input, before);
  assert.deepEqual(parsed.map((entry) => entry.id), [cli.id, acp.id]);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(parsed.every(Object.isFrozen));
  assert.ok(Object.isFrozen(parsed[1].launch));
  assert.ok(Object.isFrozen(parsed[1].launch?.args));
  assert.equal(Object.isFrozen(input.connections), false);
  const source = input.connections[1] as typeof acp;
  assert.equal(Object.isFrozen(source.launch.args), false);
  source.launch.args[0] = "changed";
  source.launch.command = path.join(path.dirname(command), "other-agent");
  input.connections.pop();
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[1].launch, { command, args: ["acp", "--model", "custom-model"] });
});

test("ACP argv preserves empty strings and shell-looking text as literal arguments", () => {
  const literals = ["", "two words", "$HOME", "~/agent", "$(echo not-expanded)", "; echo literal", "line\nbreak"];
  const args = ["--model", "{model}", ...literals];
  const parsed = parseConnections(config([{ ...acp, launch: { command, args } }]));
  assert.deepEqual(parsed[0].launch, { command, args: ["--model", acp.model, ...literals] });
  assert.deepEqual(args, ["--model", "{model}", ...literals]);
});

test("duplicate IDs are diagnosed before validating the duplicate adapter", () => {
  assert.throws(() => parseConnections(config([cli, { ...cli, adapter: "unknown" }])), /duplicate connection id/);
});

test("selecting a valid entry does not silently ignore a malformed unselected entry", (t) => {
  const f = fixture(t, config([cli, { ...acp, launch: { command, args: [5] } }]));
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /ACP args must be an array of strings/);
});

for (const size of [65535, 65536, 65537]) {
  test(`connections file limit counts UTF-8 bytes at ${size} bytes`, (t) => {
    const f = fixture(t);
    const json = JSON.stringify(config());
    assert.ok(Buffer.byteLength(json) > json.length, "fixture must include multibyte text");
    const raw = json + " ".repeat(size - Buffer.byteLength(json));
    assert.equal(Buffer.byteLength(raw), size);
    writeFileSync(f.file, raw);
    if (size > 65536) {
      assert.throws(() => resolveConnectionOptions({ connection: cli.id }, f.repo, f.env), /64 KiB/);
    } else {
      assert.equal(resolveConnectionOptions({ connection: cli.id }, f.repo, f.env).connection, cli.id);
    }
  });
}

test("repository config is rejected beneath a worktree-style .git file", (t) => {
  const f = fixture(t);
  rmSync(path.join(f.repo, ".git"), { recursive: true });
  writeFileSync(path.join(f.repo, ".git"), "gitdir: ../worktree-metadata\n");
  const inside = path.join(f.repo, "connections.json");
  writeFileSync(inside, JSON.stringify(config()));
  assert.throws(() => resolveConnectionOptions({ connection: cli.id }, path.join(f.repo, "sub"), {
    NEEDLEFISH_CONNECTIONS_FILE: inside,
  }), /outside the reviewed repository/);
});

test("a sibling directory sharing the repository name prefix remains outside the target", (t) => {
  const f = fixture(t);
  const sibling = `${f.repo}-config`;
  mkdirSync(sibling);
  const file = path.join(sibling, "connections.json");
  writeFileSync(file, JSON.stringify(config()));
  assert.equal(resolveConnectionOptions({ connection: cli.id }, f.repo, {
    NEEDLEFISH_CONNECTIONS_FILE: file,
  }).connection, cli.id);
});

test("a symlink between user-owned paths outside the repository remains supported", { skip: process.platform === "win32" }, (t) => {
  const f = fixture(t);
  const link = path.join(f.dir, "selected.json");
  symlinkSync(f.file, link);
  assert.equal(resolveConnectionOptions({ connection: cli.id }, f.repo, {
    NEEDLEFISH_CONNECTIONS_FILE: link,
  }).connection, cli.id);
});
