import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MANAGED_PREFIX = "needlefish-managed-";
const STAGING_PREFIX = ".needlefish-staging-";
const LEGACY_PREFIX = "needlefish-";
const QUARANTINE_PREFIX = ".needlefish-quarantine-";
const OWNER_FILE = ".needlefish-owner.json";
const PROCESS_LOCK_PREFIX = ".needlefish-owner-lock-";
const SWEEP_LOCK = ".needlefish-sweep.lock";
const LEGACY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_HOLDER = ': > "$1"; IFS= read -r _ || exit 0';

interface HeldLock {
  readonly child: ChildProcess;
}

interface OwnerMetadata {
  readonly pid: number;
  readonly processStartTime: string;
  readonly bootId: string;
  readonly ownerLock: string;
  readonly createdAt: number;
}

interface ProcessOwner {
  readonly lock: HeldLock;
  readonly metadata: OwnerMetadata;
}

interface RunnerProcessGroup {
  readonly directory: string | null;
  readonly terminate: (signal: NodeJS.Signals) => void;
  readonly kill: () => void;
  readonly exited: Promise<void>;
}

const activeTempDirectories = new Set<string>();
const activeRunnerProcessGroups = new Map<number, RunnerProcessGroup>();
const startupSweeps = new Map<string, Promise<void>>();
let processOwnerPromise: Promise<ProcessOwner> | null = null;
let coordinatorInstalled = false;
let terminationSignal: "SIGINT" | "SIGTERM" | null = null;
let lockSequence = 0;

function isLinux(): boolean {
  return process.platform === "linux";
}

export function installTerminationCoordinator(): void {
  if (coordinatorInstalled) return;
  coordinatorInstalled = true;
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
}

export async function initializeTempLifecycle(): Promise<void> {
  installTerminationCoordinator();
  if (!isLinux()) return;
  await ensureStartupSweep(resolveNeedlefishTempRoot());
}

export function resolveNeedlefishTempRoot(): string {
  const configured = process.env.NEEDLEFISH_TMPDIR?.trim();
  return path.resolve(configured === undefined || configured === "" ? os.tmpdir() : configured);
}

export async function createManagedTempDirectory(): Promise<string> {
  const root = resolveNeedlefishTempRoot();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  installTerminationCoordinator();
  assertRunnerSchedulingAllowed();

  if (!isLinux()) {
    const directory = mkdtempSync(path.join(root, LEGACY_PREFIX));
    activeTempDirectories.add(directory);
    return directory;
  }

  await ensureStartupSweep(root);
  assertRunnerSchedulingAllowed();

  const owner = await ensureProcessOwner(root);
  const staging = mkdtempSync(path.join(root, STAGING_PREFIX));
  try {
    assertRunnerSchedulingAllowed();
    writeFileSync(path.join(staging, OWNER_FILE), `${JSON.stringify(owner.metadata)}\n`, {
      mode: 0o600,
    });
    const suffix = path.basename(staging).slice(STAGING_PREFIX.length);
    const managed = path.join(root, `${MANAGED_PREFIX}${suffix}`);
    renameSync(staging, managed);
    activeTempDirectories.add(managed);
    return managed;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function disposeManagedTempDirectory(directory: string): Promise<void> {
  if (!activeTempDirectories.has(directory)) {
    throw new Error(`temp directory is not registered: ${directory}`);
  }
  if (terminationSignal !== null) return;
  await rm(directory, { recursive: true, force: true });
  activeTempDirectories.delete(directory);
}

export function registerRunnerProcessGroup(
  pid: number,
  repoPath: string,
  terminate: (signal: NodeJS.Signals) => void,
  kill: () => void,
  exited: Promise<void>,
): () => void {
  installTerminationCoordinator();
  assertRunnerSchedulingAllowed();
  activeRunnerProcessGroups.set(pid, {
    directory: findRegisteredTempDirectory(repoPath),
    terminate,
    kill,
    exited,
  });
  return () => {
    if (terminationSignal === null) activeRunnerProcessGroups.delete(pid);
  };
}

export async function reapManagedTempDirectories(root = resolveNeedlefishTempRoot()): Promise<void> {
  if (!isLinux()) return;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const sweepLock = await acquireLock(path.join(root, SWEEP_LOCK));
  if (sweepLock === null) return;

  try {
    const quarantined: string[] = [];
    let sequence = 0;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const source = path.join(root, entry.name);
      if (isManagedName(entry.name)) {
        const owner = readOwnerMetadata(source);
        if (owner === null || ownerIsAlive(owner) || !canTakeLock(owner.ownerLock)) continue;
      } else if (isLegacyName(entry.name)) {
        if (Date.now() - statSync(source).mtimeMs < LEGACY_GRACE_MS) continue;
      } else if (!isQuarantineName(entry.name)) {
        continue;
      }

      if (isQuarantineName(entry.name)) {
        quarantined.push(source);
        continue;
      }
      const quarantine = path.join(
        root,
        `${QUARANTINE_PREFIX}${process.pid}-${Date.now()}-${sequence++}`,
      );
      renameSync(source, quarantine);
      quarantined.push(quarantine);
    }

    await Promise.all(quarantined.map((directory) => rm(directory, { recursive: true, force: true })));
  } finally {
    await releaseLock(sweepLock);
  }
}

function ensureStartupSweep(root: string): Promise<void> {
  const existing = startupSweeps.get(root);
  if (existing !== undefined) return existing;
  const sweep = reapManagedTempDirectories(root);
  startupSweeps.set(root, sweep);
  return sweep;
}

async function ensureProcessOwner(root: string): Promise<ProcessOwner> {
  if (processOwnerPromise !== null) {
    const owner = await processOwnerPromise;
    if (owner.lock.child.exitCode !== null || owner.lock.child.signalCode !== null) {
      throw new Error("needlefish process owner lock exited unexpectedly");
    }
    return owner;
  }

  processOwnerPromise = createProcessOwner(root);
  return await processOwnerPromise;
}

async function createProcessOwner(root: string): Promise<ProcessOwner> {
  const pid = process.pid;
  const processStartTime = readProcessStartTime(pid);
  const bootId = readBootId();
  const ownerLock = path.join(root, `${PROCESS_LOCK_PREFIX}${bootId}-${pid}-${processStartTime}.lock`);
  const lock = await acquireLock(ownerLock);
  if (lock === null) throw new Error(`failed to acquire process owner lock: ${ownerLock}`);
  return {
    lock,
    metadata: { pid, processStartTime, bootId, ownerLock, createdAt: Date.now() },
  };
}

function onSigint(): void {
  coordinateTermination("SIGINT");
}

function onSigterm(): void {
  coordinateTermination("SIGTERM");
}

function coordinateTermination(signal: "SIGINT" | "SIGTERM"): void {
  if (terminationSignal !== null) {
    if (isLinux()) terminateNow(terminationSignal);
    for (const group of activeRunnerProcessGroups.values()) group.kill();
    return;
  }
  terminationSignal = signal;
  for (const group of activeRunnerProcessGroups.values()) group.terminate(signal);
  if (!isLinux()) {
    void terminatePortable(signal);
    return;
  }
  if (activeRunnerProcessGroups.size === 0) {
    terminateNow(signal);
    return;
  }
  setTimeout(() => terminateNow(signal), terminationGraceMs());
}

async function terminatePortable(signal: "SIGINT" | "SIGTERM"): Promise<never> {
  const groups = [...activeRunnerProcessGroups.values()];
  if (groups.length > 0) await wait(terminationGraceMs());
  for (const group of groups) group.kill();
  const exited = await Promise.all(groups.map((group) => waitForExit(group)));
  const unsafeDirectories = new Set<string>();
  let unmappedRunnerIsAlive = false;
  for (let index = 0; index < groups.length; index++) {
    if (exited[index]) continue;
    const directory = groups[index]?.directory;
    if (directory === null || directory === undefined) unmappedRunnerIsAlive = true;
    else unsafeDirectories.add(directory);
  }
  for (const directory of activeTempDirectories) {
    if (unmappedRunnerIsAlive || unsafeDirectories.has(directory)) continue;
    await rm(directory, { recursive: true, force: true });
    activeTempDirectories.delete(directory);
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function terminateNow(signal: "SIGINT" | "SIGTERM"): never {
  for (const group of activeRunnerProcessGroups.values()) group.kill();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function terminationGraceMs(): number {
  const configured = process.env.NEEDLEFISH_TERMINATION_GRACE_MS?.trim();
  if (configured === undefined || configured === "") return 5000;
  const parsed = Number(configured);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5000;
}

function findRegisteredTempDirectory(repoPath: string): string | null {
  const resolvedRepoPath = path.resolve(repoPath);
  for (const directory of activeTempDirectories) {
    const relative = path.relative(directory, resolvedRepoPath);
    if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) {
      return directory;
    }
  }
  return null;
}

async function waitForExit(group: RunnerProcessGroup): Promise<boolean> {
  return await new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(false), terminationGraceMs());
    group.exited.then(() => {
      clearTimeout(timeout);
      resolve(true);
    });
  });
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function assertRunnerSchedulingAllowed(): void {
  if (terminationSignal !== null) {
    throw new Error(`cannot schedule runner work while terminating from ${terminationSignal}`);
  }
}

async function acquireLock(target: string): Promise<HeldLock | null> {
  const readyPath = `${target}.ready-${process.pid}-${lockSequence++}`;
  const child = spawn(
    "flock",
    [
      "--exclusive",
      "--nonblock",
      "--no-fork",
      target,
      "sh",
      "-c",
      LOCK_HOLDER,
      "needlefish-lock-holder",
      readyPath,
    ],
    { detached: true, stdio: ["pipe", "ignore", "ignore"] },
  );

  return await new Promise<HeldLock | null>((resolve, reject) => {
    let settled = false;
    const finish = (result: HeldLock | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timeout);
      if (existsSync(readyPath)) unlinkSync(readyPath);
      if (error !== undefined) reject(error);
      else resolve(result);
    };
    const poll = setInterval(() => {
      if (!existsSync(readyPath)) return;
      const lock = { child };
      child.unref();
      const stdin = child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null;
      stdin?.unref?.();
      finish(lock);
    }, 5);
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(null, new Error(`timed out acquiring lock: ${target}`));
    }, 5000);
    child.on("error", (error) => finish(null, error));
    child.on("exit", (status) => {
      if (status === 1) {
        finish(null);
        return;
      }
      finish(null, new Error(`flock exited ${status}`));
    });
  });
}

async function releaseLock(lock: HeldLock): Promise<void> {
  if (lock.child.exitCode !== null || lock.child.signalCode !== null) return;
  lock.child.ref();
  const exited = new Promise<void>((resolve) => lock.child.once("exit", () => resolve()));
  lock.child.stdin?.end();
  await exited;
}

function canTakeLock(target: string): boolean {
  const result = spawnSync("flock", ["--exclusive", "--nonblock", target, "true"], {
    stdio: "ignore",
  });
  if (result.error !== undefined) throw result.error;
  return result.status === 0;
}

function readBootId(): string {
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!/^[A-Za-z0-9-]+$/.test(bootId)) throw new Error("invalid Linux boot ID");
  return bootId;
}

function readProcessStartTime(pid: number): string {
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8").trim();
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const startTime = fields[19];
  if (startTime === undefined || !/^\d+$/.test(startTime)) {
    throw new Error(`invalid /proc/${pid}/stat`);
  }
  return startTime;
}

function ownerIsAlive(owner: OwnerMetadata): boolean {
  try {
    return readBootId() === owner.bootId && readProcessStartTime(owner.pid) === owner.processStartTime;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

function readOwnerMetadata(directory: string): OwnerMetadata | null {
  const metadataPath = path.join(directory, OWNER_FILE);
  if (!existsSync(metadataPath)) return null;
  const value: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("pid" in value) ||
    !Number.isInteger(value.pid) ||
    typeof value.pid !== "number" ||
    value.pid <= 0 ||
    !("processStartTime" in value) ||
    typeof value.processStartTime !== "string" ||
    !/^\d+$/.test(value.processStartTime) ||
    !("bootId" in value) ||
    typeof value.bootId !== "string" ||
    !/^[A-Za-z0-9-]+$/.test(value.bootId) ||
    !("ownerLock" in value) ||
    typeof value.ownerLock !== "string" ||
    !path.isAbsolute(value.ownerLock) ||
    !("createdAt" in value) ||
    typeof value.createdAt !== "number"
  ) {
    return null;
  }
  const expectedLockName = `${PROCESS_LOCK_PREFIX}${value.bootId}-${value.pid}-${value.processStartTime}.lock`;
  if (path.basename(value.ownerLock) !== expectedLockName) return null;
  return value as OwnerMetadata;
}

function isManagedName(name: string): boolean {
  return /^needlefish-managed-[A-Za-z0-9]{6}$/.test(name);
}

function isLegacyName(name: string): boolean {
  return /^needlefish-[A-Za-z0-9]{6}$/.test(name);
}

function isQuarantineName(name: string): boolean {
  return /^\.needlefish-quarantine-\d+-\d+-\d+$/.test(name);
}
