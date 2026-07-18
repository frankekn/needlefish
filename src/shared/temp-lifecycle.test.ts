import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  reapManagedTempDirectories,
  resolveNeedlefishTempRoot,
} from "./temp-lifecycle";

const lifecycleUrl = pathToFileURL(path.resolve("src/shared/temp-lifecycle.ts")).href;
const runnerProcessUrl = pathToFileURL(path.resolve("src/shared/runner-process.ts")).href;

test("NEEDLEFISH_TMPDIR overrides the ambient temp root", (t) => {
  const previous = process.env.NEEDLEFISH_TMPDIR;
  t.after(() => {
    if (previous === undefined) delete process.env.NEEDLEFISH_TMPDIR;
    else process.env.NEEDLEFISH_TMPDIR = previous;
  });
  process.env.NEEDLEFISH_TMPDIR = path.join("relative", "scratch");
  assert.equal(resolveNeedlefishTempRoot(), path.resolve("relative", "scratch"));
});

test("startup reaper preserves a locked live directory and removes it after owner death", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const owner = spawnModule(`
import { createManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
const directory = await createManagedTempDirectory();
setInterval(() => {}, 1000);
`, root);
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const directory = await waitForManagedDirectory(root);
  assert.equal(path.dirname(directory), root);
  assert.equal(existsSync(directory), true);

  await reapManagedTempDirectories(root);
  assert.equal(existsSync(directory), true, "a kernel-locked live directory must be preserved");

  owner.kill("SIGKILL");
  await waitForExit(owner);
  for (let attempt = 0; attempt < 20 && existsSync(directory); attempt++) {
    await reapManagedTempDirectories(root);
    await delay(25);
  }
  assert.equal(existsSync(directory), false, "the unlocked orphan must be reaped");
});

test("startup reaper gives recent legacy directories an age grace", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const legacy = path.join(root, "needlefish-Ab12Cd");
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, "payload"), "x");
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await reapManagedTempDirectories(root);
  assert.equal(existsSync(legacy), true, "a recent markerless legacy directory must be preserved");

  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(legacy, old, old);
  await reapManagedTempDirectories(root);
  assert.equal(existsSync(legacy), false, "a legacy directory past the grace must be reaped");
});

for (const [signal, expectedStatus] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`process ${signal} stops and kills the runner group without deleting its live tree`, { timeout: 10_000, skip: process.platform !== "linux" }, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
    const termMarker = path.join(root, "runner-saw-tree");
    const pidPath = path.join(root, "runner-pid");
    const owner = spawnModule(`
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createManagedTempDirectory, disposeManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
import { spawnRunnerProcess } from ${JSON.stringify(runnerProcessUrl)};
const directory = await createManagedTempDirectory();
const runnerRepo = path.join(directory, "runner-repo");
mkdirSync(runnerRepo);
const runner = path.join(runnerRepo, "runner.js");
writeFileSync(runner, ${JSON.stringify(`
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const onSignal = () => {
  fs.writeFileSync(${JSON.stringify(termMarker)}, String(fs.existsSync(process.cwd()) && fs.existsSync(__filename)));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
setInterval(() => {}, 1000);
`)});
const running = spawnRunnerProcess({
  command: process.execPath,
  args: [runner],
  stdin: "",
  repoPath: runnerRepo,
  timeoutMs: 60_000,
  env: process.env,
});
try {
  await running;
} finally {
  await disposeManagedTempDirectory(directory);
}
`, root, {
      NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "1000",
      NEEDLEFISH_TERMINATION_GRACE_MS: "150",
    });
    const cleanup: { runnerPid?: number } = {};
    t.after(() => {
      killIfRunning(owner.pid);
      if (cleanup.runnerPid !== undefined) killIfRunning(-cleanup.runnerPid);
      rmSync(root, { recursive: true, force: true });
    });

    const directory = await waitForManagedDirectory(root);
    await waitForFile(pidPath);
    const runnerPid = Number(readFileSync(pidPath, "utf8"));
    cleanup.runnerPid = runnerPid;
    const started = Date.now();
    owner.kill(signal);
    const [status, exitSignal] = await waitForExit(owner);

    assert.equal(status, expectedStatus);
    assert.equal(exitSignal, null);
    assert.ok(Date.now() - started < 2000, "termination must stay bounded");
    assert.equal(readFileSync(termMarker, "utf8"), "true");
    assert.equal(existsSync(directory), true, "signal handling must leave deletion to the reaper");
    assert.throws(() => process.kill(-runnerPid, 0), isMissingProcess);

    await reapUntilGone(root, directory);
    assert.equal(existsSync(directory), false);
  });
}

test("all managed directories share one process owner lock and holder", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const marker = path.join(root, "directories.json");
  const owner = spawnModule(`
import { writeFileSync } from "node:fs";
import { createManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
const directories = await Promise.all([
  createManagedTempDirectory(),
  createManagedTempDirectory(),
  createManagedTempDirectory(),
]);
writeFileSync(${JSON.stringify(marker)}, JSON.stringify(directories));
setInterval(() => {}, 1000);
`, root);
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  await waitForFile(marker);
  const directories = JSON.parse(readFileSync(marker, "utf8")) as string[];
  const ownerLocks = directories.map((directory) => {
    const metadata = JSON.parse(
      readFileSync(path.join(directory, ".needlefish-owner.json"), "utf8"),
    ) as { ownerLock: string };
    return metadata.ownerLock;
  });
  assert.equal(new Set(ownerLocks).size, 1, "all directories must reference one owner lock");

  const children = readFileSync(`/proc/${owner.pid}/task/${owner.pid}/children`, "utf8")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  assert.equal(children.length, 1, "one needlefish process must have one persistent lock holder");
});

for (const [signal, expectedStatus] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
] as const) {
  test(`portable ${signal} waits for runner exit before deleting its temp tree`, { timeout: 10_000 }, async (t) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
    const readyPath = path.join(root, "ready");
    const pidPath = path.join(root, "runner-pid");
    const termMarker = path.join(root, "runner-saw-tree");
    const owner = spawnModuleOnPlatform(`
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createManagedTempDirectory, disposeManagedTempDirectory, initializeTempLifecycle } from ${JSON.stringify(lifecycleUrl)};
import { spawnRunnerProcess } from ${JSON.stringify(runnerProcessUrl)};
await initializeTempLifecycle();
const directory = await createManagedTempDirectory();
const runnerRepo = path.join(directory, "runner-repo");
mkdirSync(runnerRepo);
const runner = path.join(runnerRepo, "runner.js");
writeFileSync(runner, ${JSON.stringify(`
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
const onSignal = () => {
  fs.writeFileSync(${JSON.stringify(termMarker)}, String(fs.existsSync(process.cwd()) && fs.existsSync(__filename)));
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
setInterval(() => {}, 1000);
`)});
writeFileSync(${JSON.stringify(readyPath)}, directory);
const running = spawnRunnerProcess({
  command: process.execPath,
  args: [runner],
  stdin: "",
  repoPath: runnerRepo,
  timeoutMs: 60_000,
  env: process.env,
});
try {
  await running;
} finally {
  await disposeManagedTempDirectory(directory);
}
`, root, "darwin", {
      NEEDLEFISH_RUNNER_TIMEOUT_GRACE_MS: "1000",
      NEEDLEFISH_TERMINATION_GRACE_MS: "100",
      PATH: "/needlefish-test-no-tools",
    });
    const cleanup: { runnerPid?: number } = {};
    t.after(() => {
      killIfRunning(owner.pid);
      if (cleanup.runnerPid !== undefined) killIfRunning(-cleanup.runnerPid);
      rmSync(root, { recursive: true, force: true });
    });

    await waitForFile(readyPath);
    await waitForFile(pidPath);
    const directory = readFileSync(readyPath, "utf8");
    const runnerPid = Number(readFileSync(pidPath, "utf8"));
    cleanup.runnerPid = runnerPid;
    owner.kill(signal);
    const [status, exitSignal] = await waitForExit(owner);

    assert.equal(status, expectedStatus);
    assert.equal(exitSignal, null);
    assert.equal(readFileSync(termMarker, "utf8"), "true");
    assert.throws(() => process.kill(-runnerPid, 0), isMissingProcess);
    assert.equal(existsSync(directory), false, "temp tree must be deleted after runner close");
  });
}

test("portable termination preserves a temp tree when runner exit cannot be confirmed", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const readyPath = path.join(root, "ready");
  const termMarker = path.join(root, "term-seen");
  const killMarker = path.join(root, "kill-seen");
  const owner = spawnModuleOnPlatform(`
import { writeFileSync } from "node:fs";
import { createManagedTempDirectory, initializeTempLifecycle, registerRunnerProcessGroup } from ${JSON.stringify(lifecycleUrl)};
await initializeTempLifecycle();
const directory = await createManagedTempDirectory();
registerRunnerProcessGroup(
  123,
  directory,
  () => writeFileSync(${JSON.stringify(termMarker)}, "1"),
  () => writeFileSync(${JSON.stringify(killMarker)}, "1"),
  new Promise(() => {}),
);
writeFileSync(${JSON.stringify(readyPath)}, directory);
setInterval(() => {}, 1000);
`, root, "darwin", {
    NEEDLEFISH_TERMINATION_GRACE_MS: "50",
    PATH: "/needlefish-test-no-tools",
  });
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  await waitForFile(readyPath);
  const directory = readFileSync(readyPath, "utf8");
  owner.kill("SIGTERM");
  const [status, signal] = await waitForExit(owner);

  assert.equal(status, 143);
  assert.equal(signal, null);
  assert.equal(existsSync(termMarker), true);
  assert.equal(existsSync(killMarker), true);
  assert.equal(existsSync(directory), true, "unconfirmed runner temp tree must be preserved");
});

test("non-Linux lifecycle uses finally-cleaned legacy temp directories without flock", async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const marker = path.join(root, "fallback.json");
  const owner = spawnModuleOnPlatform(`
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as lifecycle from ${JSON.stringify(lifecycleUrl)};
await lifecycle.initializeTempLifecycle();
const directory = await lifecycle.createManagedTempDirectory();
const name = path.basename(directory);
await lifecycle.disposeManagedTempDirectory(directory);
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ name, exists: existsSync(directory) }));
`, root, "darwin", { PATH: "/needlefish-test-no-tools" });
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const [status, signal] = await waitForExit(owner);
  assert.equal(signal, null);
  assert.equal(status, 0, owner.stderr.read()?.toString());
  const result = JSON.parse(readFileSync(marker, "utf8")) as { name: string; exists: boolean };
  assert.match(result.name, /^needlefish-[A-Za-z0-9]{6}$/);
  assert.equal(result.exists, false);
});

for (const flag of ["--help", "--version"] as const) {
  test(`${flag} bypasses temp lifecycle initialization`, async () => {
    const importIndex = process.execArgv.indexOf("--import");
    const importTarget = process.execArgv[importIndex + 1];
    if (importIndex === -1 || importTarget === undefined) {
      throw new Error("test process is missing its TypeScript import hook");
    }
    const child = spawn(
      process.execPath,
      ["--import", importTarget, path.resolve("src/cli.ts"), flag],
      {
        env: { ...process.env, NEEDLEFISH_TMPDIR: "/proc/needlefish-must-not-be-created" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const [status, signal] = await waitForExit(child);
    assert.equal(signal, null);
    assert.equal(status, 0, child.stderr.read()?.toString());
  });
}

function spawnModule(source: string, tmpRoot: string, extraEnv: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const importIndex = process.execArgv.indexOf("--import");
  const importTarget = process.execArgv[importIndex + 1];
  if (importIndex === -1 || importTarget === undefined) {
    throw new Error("test process is missing its TypeScript import hook");
  }
  return spawn(
    process.execPath,
    ["--import", importTarget, "--input-type=module", "--eval", source],
    {
      env: { ...process.env, ...extraEnv, NEEDLEFISH_TMPDIR: tmpRoot },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function spawnModuleOnPlatform(
  source: string,
  tmpRoot: string,
  platform: NodeJS.Platform,
  extraEnv: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  const preload = path.join(tmpRoot, `.platform-${platform}.cjs`);
  writeFileSync(
    preload,
    `Object.defineProperty(process, "platform", { value: ${JSON.stringify(platform)} });\n`,
  );
  const importIndex = process.execArgv.indexOf("--import");
  const importTarget = process.execArgv[importIndex + 1];
  if (importIndex === -1 || importTarget === undefined) {
    throw new Error("test process is missing its TypeScript import hook");
  }
  return spawn(
    process.execPath,
    ["--require", preload, "--import", importTarget, "--input-type=module", "--eval", source],
    {
      env: { ...process.env, ...extraEnv, NEEDLEFISH_TMPDIR: tmpRoot },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

async function waitForFile(file: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(file)) return;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${file}`);
}

async function waitForManagedDirectory(root: string): Promise<string> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const name = readdirSync(root).find((entry) => /^needlefish-managed-[A-Za-z0-9]{6}$/.test(entry));
    if (name !== undefined) return path.join(root, name);
    await delay(20);
  }
  throw new Error(`timed out waiting for a managed directory under ${root}`);
}

async function reapUntilGone(root: string, directory: string): Promise<void> {
  for (let attempt = 0; attempt < 20 && existsSync(directory); attempt++) {
    await reapManagedTempDirectories(root);
    await delay(25);
  }
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<[number | null, NodeJS.Signals | null]> {
  return await new Promise((resolve) => child.once("exit", (status, signal) => resolve([status, signal])));
}

function killIfRunning(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}
