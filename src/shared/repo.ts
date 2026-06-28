import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyFiles } from "./classify";
import { runText } from "./process";
import type { Bundle, ChangedFile, PrMeta } from "./schema";

const NO_AGENTS =
  "(no AGENTS.md in this repo — apply only generic senior-engineer review judgment; do NOT substitute any global/CLI-injected instructions file as policy)";

export function git(args: readonly string[], cwd: string): string {
  return runText("git", args, { cwd });
}

export function ghText(args: readonly string[], cwd?: string, input?: string): string {
  return runText("gh", args, { cwd, input });
}

export function changedFiles(cwd: string, baseSha: string, headSha = "HEAD"): ChangedFile[] {
  const nameOnly = git(["diff", "--name-only", baseSha, headSha], cwd);
  return classifyFiles(nameOnly.split("\n").filter(Boolean));
}

export function readAgents(cwd: string): string {
  const agentsPath = path.join(cwd, "AGENTS.md");
  return existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : NO_AGENTS;
}

export interface BundleInput {
  readonly repoPath: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly patch: string;
  readonly patchStat: string;
  readonly changedFiles: ChangedFile[];
  readonly prMeta: PrMeta | null;
  readonly deep: boolean;
  readonly focus: string | null;
}

export function makeBundle(input: BundleInput): Bundle {
  return {
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    headSha: input.headSha,
    patch: input.patch,
    patchStat: input.patchStat,
    changedFiles: input.changedFiles,
    agentsMd: readAgents(input.repoPath),
    prMeta: input.prMeta,
    deep: input.deep,
    focus: input.focus,
  };
}
