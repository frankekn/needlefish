import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface CodexOptions {
  repoPath: string;
  model?: string;
  timeoutMs?: number;
}

export async function runCodex(prompt: string, opts: CodexOptions): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return runCodexOnce(prompt, opts);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      lastErr = err;
      if (attempt < 2) {
        const backoff = Number(process.env.CODEX_RETRY_MS ?? 5000);
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
    }
  }
  throw lastErr;
}

function runCodexOnce(prompt: string, opts: CodexOptions): string {
  const bin = process.env.CODEX_BIN ?? "codex";
  const model = opts.model ?? process.env.CODEX_MODEL;
  const timeoutMs =
    opts.timeoutMs ?? Number(process.env.CODEX_TIMEOUT_MS ?? 600000);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-"));
  const ghConfigDir = path.join(tmp, "gh-empty");
  mkdirSync(ghConfigDir, { recursive: true });
  const lastMsg = path.join(tmp, "last.txt");
  const args = ["exec", "--color", "never", "-s", "read-only", "--skip-git-repo-check", "--output-last-message", lastMsg];
  if (model) args.push("-m", model);

  const env: NodeJS.ProcessEnv = { ...process.env, GH_CONFIG_DIR: ghConfigDir };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GITHUB_API_TOKEN;

  const res = spawnSync(bin, args, {
    cwd: opts.repoPath,
    env,
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

export function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found in codex output");
  }
  return JSON.parse(raw.slice(start, end + 1));
}
