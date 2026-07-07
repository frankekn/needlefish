import { spawnSync } from "node:child_process";

interface RunOptions {
  readonly cwd?: string;
  readonly input?: string;
  readonly timeoutMs?: number;
}

export function runText(command: string, args: readonly string[], opts: RunOptions = {}): string {
  const res = spawnSync(command, [...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    input: opts.input,
    maxBuffer: 1024 * 1024 * 64,
    timeout: opts.timeoutMs,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed: ${(res.stderr ?? "").trim()}`);
  }
  return (res.stdout ?? "").trim();
}
