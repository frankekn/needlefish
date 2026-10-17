import { spawnSync } from "node:child_process";
import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import type { TestContext } from "node:test";
import path from "node:path";

export function readStringArray(file: string): readonly string[] {
  const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
    throw new Error("expected string array");
  }
  return raw;
}

export function gitText(args: readonly string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr ?? ""}`);
  }
  return result.stdout.trim();
}

export function initRepo(root: string): string {
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  gitText(["init"], repo);
  writeFileSync(path.join(repo, "README.md"), "fixture\n");
  gitText(["add", "README.md"], repo);
  gitText(commitArgs("init"), repo);
  return repo;
}

function commitArgs(message: string): readonly string[] {
  return [
    "-c",
    "user.name=Needlefish Test",
    "-c",
    "user.email=needlefish-test@example.invalid",
    "commit",
    "-m",
    message,
  ];
}

export function commitAll(repo: string, message: string): void {
  gitText(["add", "."], repo);
  gitText(commitArgs(message), repo);
}

export function headSha(repo: string): string {
  return gitText(["rev-parse", "HEAD"], repo);
}

export function isolateCodexTestHome(t: TestContext, root: string): void {
  const names = ["HOME", "USERPROFILE", "CODEX_HOME", "TMPDIR", "TEMP", "TMP"] as const;
  const previous = names.map(name => [name, process.env[name]] as const);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;
  delete process.env.CODEX_HOME;
  const original = fs.readFileSync;
  const guarded = t.mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    const file = args[0];
    const filename = file instanceof URL ? file.pathname : typeof file === "string" ? file : undefined;
    if (filename && ["auth.json", "config.toml"].includes(path.basename(filename))) {
      const relative = path.relative(root, path.resolve(filename));
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Codex test attempted to read auth/config outside its owned root");
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    guarded.mock.restore();
    syncBuiltinESMExports();
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
