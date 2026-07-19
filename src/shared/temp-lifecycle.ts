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
import { envFlagOn } from "./env.js";

const MANAGED_PREFIX = "needlefish-managed-";
const STAGING_PREFIX = ".needlefish-staging-";
const LEGACY_PREFIX = "needlefish-";
const QUARANTINE_PREFIX = ".needlefish-quarantine-";
const OWNER_FILE = ".needlefish-owner.json";
const PROCESS_LOCK_PREFIX = ".needlefish-owner-lock-";
const SWEEP_LOCK = ".needlefish-sweep.lock";
const LEGACY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const QUARANTINE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
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
const processOwnerPromises = new Map<string, Promise<ProcessOwner>>();
let coordinatorInstalled = false;
let terminationSignal: "SIGINT" | "SIGTERM" | null = null;
let forceTermination = false;
const terminationWaiters = new Set<() => void>();
let lockSequence = 0;

export class RunnerTerminatingError extends Error {
  readonly name = "RunnerTerminatingError";

  constructor(signal: "SIGINT" | "SIGTERM") {
    super(`cannot schedule runner work while terminating from ${signal}`);
  }
}

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
  const group: RunnerProcessGroup = {
    directory: findRegisteredTempDirectory(repoPath),
    terminate,
    kill,
    exited,
  };
  activeRunnerProcessGroups.set(pid, group);
  const unregister = (): void => {
    if (activeRunnerProcessGroups.get(pid) !== group) return;
    activeRunnerProcessGroups.delete(pid);
    notifyTerminationWaiters();
  };
  void exited.then(unregister, unregister);
  return unregister;
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
        if (!envFlagOn("NEEDLEFISH_REAP_LEGACY_TMPDIRS")) continue;
        if (Date.now() - statSync(source).mtimeMs < LEGACY_GRACE_MS) continue;
      } else if (isQuarantineName(entry.name)) {
        const owner = readOwnerMetadata(source);
        if (
          owner === null ||
          Date.now() - statSync(source).mtimeMs < QUARANTINE_GRACE_MS ||
          ownerIsAlive(owner) ||
          !canTakeLock(owner.ownerLock)
        ) {
          continue;
        }
        quarantined.push(source);
        continue;
      } else {
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
    reapOrphanedProcessOwnerLocks(root);
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
  const current = processOwnerPromises.get(root);
  if (current === undefined) return await acquireProcessOwner(root);

  let owner: ProcessOwner;
  try {
    owner = await current;
  } catch (error) {
    if (processOwnerPromises.get(root) === current) processOwnerPromises.delete(root);
    throw error;
  }
  if (lockHolderIsAlive(owner.lock)) return owner;

  if (processOwnerPromises.get(root) === current) {
    processOwnerPromises.set(root, createProcessOwner(root));
  }
  const replacement = processOwnerPromises.get(root) ?? createProcessOwner(root);
  processOwnerPromises.set(root, replacement);
  try {
    return await replacement;
  } catch (error) {
    if (processOwnerPromises.get(root) === replacement) processOwnerPromises.delete(root);
    throw error;
  }
}

async function acquireProcessOwner(root: string): Promise<ProcessOwner> {
  const acquisition = createProcessOwner(root);
  processOwnerPromises.set(root, acquisition);
  try {
    return await acquisition;
  } catch (error) {
    if (processOwnerPromises.get(root) === acquisition) processOwnerPromises.delete(root);
    throw error;
  }
}

function lockHolderIsAlive(lock: HeldLock): boolean {
  return lock.child.exitCode === null && lock.child.signalCode === null;
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
    forceTermination = true;
    notifyTerminationWaiters();
    if (isLinux()) terminateImmediately(terminationSignal);
    signalRegisteredRunners("kill", terminationSignal);
    return;
  }
  terminationSignal = signal;
  signalRegisteredRunners("terminate", signal);
  if (activeRunnerProcessGroups.size === 0) {
    terminateImmediately(signal);
    return;
  }
  void completeTermination(signal);
}

function notifyTerminationWaiters(): void {
  for (const wake of [...terminationWaiters]) wake();
}

async function waitForRegisteredRunners(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (activeRunnerProcessGroups.size > 0) {
    if (forceTermination) return false;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        terminationWaiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, remaining);
      terminationWaiters.add(finish);
      if (activeRunnerProcessGroups.size === 0 || forceTermination) finish();
    });
  }
  return true;
}

function signalRegisteredRunners(method: "terminate" | "kill", signal: "SIGINT" | "SIGTERM"): void {
  for (const [pid, group] of [...activeRunnerProcessGroups.entries()]) {
    if (activeRunnerProcessGroups.get(pid) !== group) continue;
    try {
      if (method === "terminate") group.terminate(signal);
      else group.kill();
    } catch (error) {
      if (!isGoneProcessError(error)) throw error;
    }
  }
}

function isGoneProcessError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "ESRCH" || error.code === "EPERM")
  );
}

async function completeTermination(signal: "SIGINT" | "SIGTERM"): Promise<never> {
  const exitedDuringGrace = await waitForRegisteredRunners(terminationGraceMs());
  if (!exitedDuringGrace) signalRegisteredRunners("kill", signal);

  if (isLinux()) process.exit(signal === "SIGINT" ? 130 : 143);

  await waitForRegisteredRunners(terminationGraceMs());
  const unsafeDirectories = new Set<string>();
  let unmappedRunnerIsAlive = false;
  for (const group of activeRunnerProcessGroups.values()) {
    if (group.directory === null) unmappedRunnerIsAlive = true;
    else unsafeDirectories.add(group.directory);
  }
  for (const directory of [...activeTempDirectories]) {
    if (unmappedRunnerIsAlive || unsafeDirectories.has(directory)) continue;
    await rm(directory, { recursive: true, force: true });
    activeTempDirectories.delete(directory);
  }
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function terminateImmediately(signal: "SIGINT" | "SIGTERM"): never {
  signalRegisteredRunners("kill", signal);
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

export function assertRunnerSchedulingAllowed(): void {
  if (terminationSignal !== null) {
    throw new RunnerTerminatingError(terminationSignal);
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
      if (!lockHolderIsAlive(lock) || canTakeLock(target) || !lockHolderIsAlive(lock)) {
        child.kill("SIGKILL");
        finish(null, new Error(`lock holder reported ready without holding the lock: ${target}`));
        return;
      }
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
  return ownerIdentityIsAlive(owner);
}

function ownerIdentityIsAlive(owner: Pick<OwnerMetadata, "pid" | "processStartTime" | "bootId">): boolean {
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
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
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
  if (path.dirname(value.ownerLock) !== path.dirname(directory)) return null;
  return value as OwnerMetadata;
}

function parseProcessOwnerLock(name: string): Pick<OwnerMetadata, "pid" | "processStartTime" | "bootId"> | null {
  const match = /^\.needlefish-owner-lock-(.+)-(\d+)-(\d+)\.lock$/.exec(name);
  if (match === null) return null;
  const [, bootId, pidText, processStartTime] = match;
  if (
    bootId === undefined ||
    !/^[A-Za-z0-9-]+$/.test(bootId) ||
    pidText === undefined ||
    processStartTime === undefined
  ) {
    return null;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  return { pid, processStartTime, bootId };
}

function reapOrphanedProcessOwnerLocks(root: string): void {
  const referencedLocks = new Set<string>();
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || (!isManagedName(entry.name) && !isQuarantineName(entry.name))) continue;
    const owner = readOwnerMetadata(path.join(root, entry.name));
    if (owner === null) continue;
    referencedLocks.add(owner.ownerLock);
  }

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const owner = parseProcessOwnerLock(entry.name);
    if (owner === null) continue;
    const ownerLock = path.join(root, entry.name);
    if (referencedLocks.has(ownerLock) || ownerIdentityIsAlive(owner) || !canTakeLock(ownerLock)) continue;
    unlinkSync(ownerLock);
  }
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
