import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexOptions {
  repoPath: string;
  model?: string;
  timeoutMs?: number;
}

export function runCodex(prompt: string, opts: CodexOptions): string {
  const bin = process.env.CODEX_BIN ?? "codex";
  const model = opts.model ?? process.env.CODEX_MODEL;
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 600000);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-"));
  const lastMsg = path.join(tmp, "last.txt");
  const args = ["exec", "--color", "never", "-s", "read-only", "--output-last-message", lastMsg];
  if (model) args.push("-m", model);

  const res = spawnSync(bin, args, {
    cwd: opts.repoPath,
    input: prompt,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024 * 64,
  });

  let out = "";
  try {
    out = readFileSync(lastMsg, "utf8");
  } catch {
    out = res.stdout ?? "";
  }
  rmSync(tmp, { recursive: true, force: true });

  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(
      `codex exec exited ${res.status}: ${(res.stderr ?? "").slice(0, 2000)}`
    );
  }
  return out;
}

export function extractJson(text: string): any {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found in codex output");
  }
  return JSON.parse(raw.slice(start, end + 1));
}
