import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
