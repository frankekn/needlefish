import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
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
  RunnerTerminatingError,
} from "./temp-lifecycle";
import { isRunnerSafetyError } from "./runner-sandbox";

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
  const previous = process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS;
  mkdirSync(legacy);
  writeFileSync(path.join(legacy, "payload"), "x");
  t.after(() => {
    if (previous === undefined) delete process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS;
    else process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS = previous;
    rmSync(root, { recursive: true, force: true });
  });
  process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS = "1";

  await reapManagedTempDirectories(root);
  assert.equal(existsSync(legacy), true, "a recent markerless legacy directory must be preserved");

  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(legacy, old, old);
  await reapManagedTempDirectories(root);
  assert.equal(existsSync(legacy), false, "a legacy directory past the grace must be reaped");
});

test("startup reaper preserves unowned legacy and quarantine directories by default", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const legacy = path.join(root, "needlefish-Ab12Cd");
  const quarantine = path.join(root, ".needlefish-quarantine-123-456-0");
  const previous = process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS;
  for (const directory of [legacy, quarantine]) {
    mkdirSync(directory);
    writeFileSync(path.join(directory, "unrelated-data"), "keep");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(directory, old, old);
  }
  t.after(() => {
    if (previous === undefined) delete process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS;
    else process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS = previous;
    rmSync(root, { recursive: true, force: true });
  });
  delete process.env.NEEDLEFISH_REAP_LEGACY_TMPDIRS;

  await reapManagedTempDirectories(root);

  assert.equal(existsSync(legacy), true, "markerless legacy data is not owned by needlefish");
  assert.equal(existsSync(quarantine), true, "markerless quarantine data is not owned by needlefish");
});

test("startup reaper ages an owned quarantine before deleting it", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const owner = spawnModule(`
import { writeFileSync } from "node:fs";
import { createManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
writeFileSync(${JSON.stringify(path.join(root, "managed"))}, await createManagedTempDirectory());
setInterval(() => {}, 1000);
`, root);
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const managedMarker = path.join(root, "managed");
  await waitForFile(managedMarker);
  const managed = readFileSync(managedMarker, "utf8");
  owner.kill("SIGKILL");
  await waitForExit(owner);
  const quarantine = path.join(root, ".needlefish-quarantine-123-456-0");
  renameSync(managed, quarantine);

  await reapManagedTempDirectories(root);
  assert.equal(existsSync(quarantine), true, "a concurrent/recent quarantine must be left alone");

  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(quarantine, old, old);
  await reapManagedTempDirectories(root);
  assert.equal(existsSync(quarantine), false, "an aged, marker-owned quarantine is collectable");
});

test("termination unregisters a runner that closes during grace and exits immediately", { timeout: 10_000 }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const ready = path.join(root, "ready");
  const killed = path.join(root, "stale-kill");
  const owner = spawnModule(`
import { writeFileSync } from "node:fs";
import { registerRunnerProcessGroup } from ${JSON.stringify(lifecycleUrl)};
let unregister = () => {};
let markExited = () => {};
const exited = new Promise((resolve) => { markExited = resolve; });
unregister = registerRunnerProcessGroup(
  123,
  ${JSON.stringify(root)},
  () => setTimeout(() => { unregister(); markExited(); }, 25),
  () => writeFileSync(${JSON.stringify(killed)}, "1"),
  exited,
);
writeFileSync(${JSON.stringify(ready)}, "1");
setInterval(() => {}, 1000);
`, root, { NEEDLEFISH_TERMINATION_GRACE_MS: "1500" });
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  await waitForFile(ready);
  const started = Date.now();
  owner.kill("SIGTERM");
  const [status, signal] = await waitForExit(owner);

  assert.equal(signal, null);
  assert.equal(status, 143);
  assert.ok(Date.now() - started < 700, "last runner close must end the grace wait");
  assert.equal(existsSync(killed), false, "an unregistered runner must never receive SIGKILL");
});

test("a dead process-owner lock holder is reacquired for later allocations", { timeout: 10_000, skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const marker = path.join(root, "directories.json");
  const owner = spawnModule(`
import { readFileSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
const first = await createManagedTempDirectory();
const childrenPath = \`/proc/\${process.pid}/task/\${process.pid}/children\`;
const holderPid = Number(readFileSync(childrenPath, "utf8").trim());
process.kill(holderPid, "SIGKILL");
for (let attempt = 0; attempt < 100; attempt++) {
  try { process.kill(holderPid, 0); } catch { break; }
  await delay(10);
}
const second = await createManagedTempDirectory();
writeFileSync(${JSON.stringify(marker)}, JSON.stringify([first, second]));
`, root);
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const [status, signal] = await waitForExit(owner);
  assert.equal(signal, null);
  assert.equal(status, 0, owner.stderr.read()?.toString());
  const directories = JSON.parse(readFileSync(marker, "utf8")) as string[];
  assert.equal(directories.length, 2);
  assert.ok(directories.every((directory) => existsSync(directory)));
});

test("lock readiness is rejected unless the holder actually owns the lock", { timeout: 10_000, skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const binDir = path.join(root, "bin");
  const fakeFlock = path.join(binDir, "flock");
  const resultPath = path.join(root, "result");
  mkdirSync(binDir);
  writeFileSync(fakeFlock, `#!/usr/bin/env node
const fs = require("node:fs");
const last = process.argv.at(-1);
if (last === "true") process.exit(0);
fs.writeFileSync(last, "ready-without-lock");
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
`);
  chmodSync(fakeFlock, 0o755);
  const owner = spawnModule(`
import { writeFileSync } from "node:fs";
import { reapManagedTempDirectories } from ${JSON.stringify(lifecycleUrl)};
try {
  await reapManagedTempDirectories(${JSON.stringify(root)});
  writeFileSync(${JSON.stringify(resultPath)}, "unexpected success");
} catch (error) {
  writeFileSync(${JSON.stringify(resultPath)}, error instanceof Error ? error.message : String(error));
}
`, root, { PATH: `${binDir}:${process.env.PATH ?? ""}` });
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const [status, signal] = await waitForExit(owner);
  assert.equal(signal, null);
  assert.equal(status, 0, owner.stderr.read()?.toString());
  assert.match(readFileSync(resultPath, "utf8"), /reported ready without holding the lock/);
});

test("startup reaper treats malformed owner JSON as an invalid marker", { skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const managed = path.join(root, "needlefish-managed-Ab12Cd");
  mkdirSync(managed);
  writeFileSync(path.join(managed, ".needlefish-owner.json"), '{"pid":');
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await reapManagedTempDirectories(root);

  assert.equal(existsSync(managed), true, "invalid ownership metadata must never authorize deletion");
});

test("termination errors use the runner safety escape hatch", () => {
  const error = new RunnerTerminatingError("SIGINT");
  assert.equal(error.name, "RunnerTerminatingError");
  assert.equal(isRunnerSafetyError(error), true);
});

test("startup reaper removes an unlocked owner file only after its owner directory is gone", { timeout: 10_000, skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const owner = spawnModule(`
import { writeFileSync } from "node:fs";
import { createManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
writeFileSync(${JSON.stringify(path.join(root, "managed"))}, await createManagedTempDirectory());
setInterval(() => {}, 1000);
`, root);
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const marker = path.join(root, "managed");
  await waitForFile(marker);
  const managed = readFileSync(marker, "utf8");
  const metadata = JSON.parse(readFileSync(path.join(managed, ".needlefish-owner.json"), "utf8")) as { ownerLock: string };
  assert.equal(existsSync(metadata.ownerLock), true);

  owner.kill("SIGKILL");
  await waitForExit(owner);
  await reapManagedTempDirectories(root);

  assert.equal(existsSync(managed), false);
  assert.equal(existsSync(metadata.ownerLock), false, "dead, unreferenced owner locks must not accumulate");
});

test("startup reaper collects an orphaned owner lock alongside a metadata-less quarantine", { timeout: 10_000, skip: process.platform !== "linux" }, async (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-lifecycle-test-"));
  const owner = spawnModule(`
import { writeFileSync } from "node:fs";
import { createManagedTempDirectory } from ${JSON.stringify(lifecycleUrl)};
writeFileSync(${JSON.stringify(path.join(root, "managed"))}, await createManagedTempDirectory());
setInterval(() => {}, 1000);
`, root);
  t.after(() => {
    killIfRunning(owner.pid);
    rmSync(root, { recursive: true, force: true });
  });

  const marker = path.join(root, "managed");
  await waitForFile(marker);
  const managed = readFileSync(marker, "utf8");
  const metadata = JSON.parse(readFileSync(path.join(managed, ".needlefish-owner.json"), "utf8")) as { ownerLock: string };
  const quarantine = path.join(root, ".needlefish-quarantine-1234-1700000000000-0");
  mkdirSync(quarantine);

  owner.kill("SIGKILL");
  await waitForExit(owner);
  await reapManagedTempDirectories(root);

  assert.equal(existsSync(managed), false);
  assert.equal(existsSync(quarantine), true, "unattributable quarantine data must be preserved");
  assert.equal(existsSync(metadata.ownerLock), false, "an unrelated unattributable quarantine must not block orphan lock collection");
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
