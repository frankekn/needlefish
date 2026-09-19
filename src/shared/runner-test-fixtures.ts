// Test-only primitives. Callers keep their existing after/finally order and
// choose which environment keys and owned process IDs to restore or clean up.
// Environment mutations must not overlap in concurrent tests in one process.
export function captureEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

export function restoreEnv(previous: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

export function isMissingProcess(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ESRCH";
}

export function killProcessIfRunning(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}
