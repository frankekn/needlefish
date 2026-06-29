import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { classifyFiles } from "./classify";
import { normalizePrMeta } from "./normalize";
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

export function readAgentsAt(cwd: string, ref: string): string {
  try {
    return git(["show", `${ref}:AGENTS.md`], cwd);
  } catch (err) {
    if (err instanceof Error) return NO_AGENTS;
    throw err;
  }
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
  readonly agentsMd?: string;
}

export function makeBundle(input: BundleInput): Bundle {
  return {
    repoPath: input.repoPath,
    baseSha: input.baseSha,
    headSha: input.headSha,
    patch: input.patch,
    patchStat: input.patchStat,
    changedFiles: input.changedFiles,
    agentsMd: input.agentsMd ?? readAgents(input.repoPath),
    prMeta: input.prMeta,
    deep: input.deep,
    focus: input.focus,
  };
}

export interface PrRefInfo {
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly prMeta: PrMeta;
}

export function fetchPrRefInfo(cwd: string, prNumber: number): PrRefInfo {
  const raw = ghText(
    [
      "pr",
      "view",
      String(prNumber),
      "--json",
      "number,title,body,comments,reviews,statusCheckRollup,baseRefOid,headRefOid,baseRefName,headRefName",
    ],
    cwd
  );
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`PR #${prNumber}: gh response was not an object`);
  }
  const record = parsed as Record<string, unknown>;
  const baseSha = typeof record.baseRefOid === "string" ? record.baseRefOid : "";
  const headSha = typeof record.headRefOid === "string" ? record.headRefOid : "";
  const baseRefName = typeof record.baseRefName === "string" ? record.baseRefName : "";
  const headRefName = typeof record.headRefName === "string" ? record.headRefName : "";
  if (!baseSha || !headSha || !baseRefName || !headRefName) {
    throw new Error(`PR #${prNumber}: could not resolve base/head refs via gh`);
  }
  return {
    baseSha,
    headSha,
    baseRefName,
    headRefName,
    prMeta: normalizePrMeta(parsed, prNumber),
  };
}

function hasCommit(cwd: string, sha: string): boolean {
  try {
    runText("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd });
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function hasMergeBase(cwd: string, baseSha: string, headSha: string): boolean {
  try {
    runText("git", ["merge-base", baseSha, headSha], { cwd });
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function tryFetch(cwd: string, args: readonly string[]): boolean {
  try {
    runText("git", args, { cwd, timeoutMs: 120000 });
    return true;
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

function listRemotes(cwd: string): string[] {
  const out = git(["remote"], cwd);
  const preferred = ["upstream", "origin"];
  const all = out.split("\n").filter(Boolean);
  return [...preferred.filter((name) => all.includes(name)), ...all.filter((name) => !preferred.includes(name))];
}

function isShallow(cwd: string): boolean {
  try {
    return git(["rev-parse", "--is-shallow-repository"], cwd) === "true";
  } catch (err) {
    if (err instanceof Error) return false;
    throw err;
  }
}

export function ensurePrCommits(cwd: string, pr: PrRefInfo): void {
  const ready = () =>
    hasCommit(cwd, pr.baseSha) &&
    hasCommit(cwd, pr.headSha) &&
    hasMergeBase(cwd, pr.baseSha, pr.headSha);
  if (ready()) return;

  const remotes = listRemotes(cwd);
  const pullRef = `pull/${pr.prMeta.number}/head`;

  for (const remote of remotes) {
    if (ready()) return;
    tryFetch(cwd, ["fetch", "--quiet", remote, pullRef]);
  }

  for (const remote of remotes) {
    for (const ref of [pr.baseRefName, pr.headRefName]) {
      if (ready()) return;
      tryFetch(cwd, ["fetch", "--quiet", remote, ref]);
    }
  }

  for (const sha of [pr.baseSha, pr.headSha]) {
    if (hasCommit(cwd, sha)) continue;
    for (const remote of remotes) {
      if (tryFetch(cwd, ["fetch", "--quiet", remote, sha])) break;
    }
  }

  if (!ready() && isShallow(cwd)) {
    for (const remote of remotes) {
      for (const ref of [pullRef, pr.baseRefName, pr.headRefName]) {
        if (ready()) return;
        if (!isShallow(cwd)) break;
        tryFetch(cwd, ["fetch", "--quiet", "--unshallow", remote, ref]);
      }
    }
  }

  const missingBase = !hasCommit(cwd, pr.baseSha);
  const missingHead = !hasCommit(cwd, pr.headSha);
  if (!missingBase && !missingHead && hasMergeBase(cwd, pr.baseSha, pr.headSha)) return;

  throw new Error(
    `PR #${pr.prMeta.number}: missing ${[
      missingBase ? "base" : "",
      missingHead ? "head" : "",
      !missingBase && !missingHead ? "merge-base" : "",
    ]
      .filter(Boolean)
      .join("/")} commit locally; try git fetch`
  );
}

export function prDiffFromShas(cwd: string, baseSha: string, headSha: string) {
  const mergeBase = git(["merge-base", baseSha, headSha], cwd);
  const patch = git(["diff", mergeBase, headSha], cwd);
  if (!patch.trim()) {
    throw new Error(`No diff between ${mergeBase} and ${headSha}. Nothing to review.`);
  }
  return {
    baseSha: mergeBase,
    headSha,
    patch,
    patchStat: git(["diff", "--stat", mergeBase, headSha], cwd),
    changedFiles: changedFiles(cwd, mergeBase, headSha),
  };
}
