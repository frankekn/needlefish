import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle, parseState } from "../../src/adapters/github";

export type Fate = "addressed" | "kept" | "pending" | "abandoned";

const FATES: readonly Fate[] = ["addressed", "kept", "pending", "abandoned"];

export interface AdoptionRow {
  readonly repo: string;
  readonly pr: number;
  readonly severity: string;
  readonly category: string;
  readonly fate: Fate;
  readonly resolved: boolean;
  readonly path: string;
  readonly created: string;
  readonly author: string | null;
}

export interface CliArgs {
  readonly repos: readonly string[];
  readonly since: string | null;
  readonly json: boolean;
}

const USAGE = `Usage: npx tsx eval/tools/adoption.ts owner/name [owner/name ...] [--since YYYY-MM-DD] [--json]

Real-PR adoption of Needlefish inline findings. A finding thread counts as
addressed when GitHub marks it outdated (its lines changed after posting).
Only merged PRs are decided; open PRs are pending, closed-unmerged PRs are
abandoned. Reads GitHub through \`gh api graphql\`.

  --since  only count finding threads created on or after this UTC date
  --json   print the raw per-thread rows as JSON instead of the Markdown report
  --help   print this message and exit
`;

export function parseCliArgs(argv: readonly string[]): CliArgs | { readonly help: true } {
  if (argv.includes("--help")) return { help: true };
  const repos: string[] = [];
  let since: string | null = null;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--since") {
      const value = argv[++i];
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
        throw new Error(`--since must be a YYYY-MM-DD date, got: ${value ?? "(missing)"}`);
      }
      since = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (/^[\w.-]+\/[\w.-]+$/.test(arg)) {
      repos.push(arg);
    } else {
      throw new Error(`repository must be owner/name, got: ${arg}`);
    }
  }
  if (repos.length === 0) throw new Error("at least one owner/name repository is required");
  return { repos, since, json };
}

export interface FindingHeader {
  readonly severity: string;
  readonly title: string;
  readonly category: string | null;
}

// Two inline header shapes have shipped: `**P2** title` (current) and
// `**P2 (category): title**` (the first releases).
export function parseFindingHeader(body: string): FindingHeader | null {
  const firstLine = body.split("\n", 1)[0] ?? "";
  const legacy = /^\*\*(P[0-3]) \(([^)]+)\): (.+)\*\*$/.exec(firstLine);
  if (legacy) return { severity: legacy[1], category: legacy[2], title: legacy[3].trim() };
  const current = /^\*\*(P[0-3])\*\* (.+)$/.exec(firstLine);
  if (current) return { severity: current[1], category: null, title: current[2].trim() };
  return null;
}

export function classifyFate(pr: { readonly state: string; readonly merged: boolean }, isOutdated: boolean): Fate {
  if (pr.merged) return isOutdated ? "addressed" : "kept";
  return pr.state === "CLOSED" ? "abandoned" : "pending";
}

export interface ThreadNode {
  readonly isOutdated: boolean;
  readonly isResolved: boolean;
  readonly path: string;
  readonly body: string;
  readonly createdAt: string;
  readonly author: string | null;
}

export interface PrNode {
  readonly number: number;
  readonly state: string;
  readonly merged: boolean;
  readonly updatedAt: string;
  readonly reviewBodies: readonly string[];
  readonly threads: readonly ThreadNode[];
  readonly threadsTruncated: boolean;
}

export interface PrPage {
  readonly prs: readonly PrNode[];
  readonly endCursor: string | null;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, what: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`expected ${what} to be a JSON object`);
  }
  return value as JsonRecord;
}

function nodes(value: unknown, what: string): unknown[] {
  const list = record(value, what).nodes;
  if (!Array.isArray(list)) throw new Error(`expected ${what}.nodes to be an array`);
  return list;
}

function str(obj: JsonRecord, key: string, what: string): string {
  const value = obj[key];
  if (typeof value !== "string") throw new Error(`expected ${what}.${key} to be a string`);
  return value;
}

function bool(obj: JsonRecord, key: string, what: string): boolean {
  const value = obj[key];
  if (typeof value !== "boolean") throw new Error(`expected ${what}.${key} to be a boolean`);
  return value;
}

function parseThread(raw: unknown): ThreadNode | null {
  const thread = record(raw, "reviewThread");
  const first = nodes(thread.comments, "reviewThread.comments")[0];
  if (first === undefined) return null;
  const comment = record(first, "reviewThread comment");
  const author = comment.author === null ? null : str(record(comment.author, "comment.author"), "login", "comment.author");
  return {
    isOutdated: bool(thread, "isOutdated", "reviewThread"),
    isResolved: bool(thread, "isResolved", "reviewThread"),
    path: str(thread, "path", "reviewThread"),
    body: str(comment, "body", "comment"),
    createdAt: str(comment, "createdAt", "comment"),
    author,
  };
}

function parsePr(raw: unknown): PrNode {
  const pr = record(raw, "pullRequest");
  const number = pr.number;
  if (typeof number !== "number") throw new Error("expected pullRequest.number to be a number");
  const reviewBodies = nodes(pr.reviews, "pullRequest.reviews").map((r) => {
    const body = record(r, "review").body;
    return typeof body === "string" ? body : "";
  });
  const threadConn = record(pr.reviewThreads, "pullRequest.reviewThreads");
  const threads = nodes(threadConn, "pullRequest.reviewThreads")
    .map(parseThread)
    .filter((t): t is ThreadNode => t !== null);
  return {
    number,
    state: str(pr, "state", "pullRequest"),
    merged: bool(pr, "merged", "pullRequest"),
    updatedAt: str(pr, "updatedAt", "pullRequest"),
    reviewBodies,
    threads,
    threadsTruncated: bool(record(threadConn.pageInfo, "reviewThreads.pageInfo"), "hasNextPage", "reviewThreads.pageInfo"),
  };
}

export function parsePrPage(raw: unknown): PrPage {
  const data = record(record(raw, "graphql response").data, "data");
  const conn = record(record(data.repository, "data.repository").pullRequests, "repository.pullRequests");
  const pageInfo = record(conn.pageInfo, "pullRequests.pageInfo");
  const hasNext = bool(pageInfo, "hasNextPage", "pullRequests.pageInfo");
  const cursor = pageInfo.endCursor;
  return {
    prs: nodes(conn, "pullRequests").map(parsePr),
    endCursor: hasNext && typeof cursor === "string" ? cursor : null,
  };
}

// Category lookup from the round-state marker. Each round PUTs a fresh marker
// onto the first-round review body, replacing the previous one, so only the
// latest round's findings are present; earlier-round threads end up unknown.
function stateCategories(reviewBodies: readonly string[]): Map<string, string> {
  const categories = new Map<string, string>();
  for (const body of reviewBodies) {
    for (const key of parseState(body)?.findings ?? []) categories.set(key.title, key.category);
  }
  return categories;
}

export function rowsFromPr(repo: string, pr: PrNode, since: string | null): AdoptionRow[] {
  const categories = stateCategories(pr.reviewBodies);
  const rows: AdoptionRow[] = [];
  for (const thread of pr.threads) {
    if (since !== null && thread.createdAt < since) continue;
    const header = parseFindingHeader(thread.body);
    if (!header) continue;
    rows.push({
      repo,
      pr: pr.number,
      severity: header.severity,
      category: header.category ?? categories.get(normalizeTitle(header.title)) ?? "unknown",
      fate: classifyFate(pr, thread.isOutdated),
      resolved: thread.isResolved,
      path: thread.path,
      created: thread.createdAt,
      author: thread.author,
    });
  }
  return rows;
}

export function isoWeek(timestamp: string): string {
  const d = new Date(timestamp);
  const mondayIndex = (d.getUTCDay() + 6) % 7;
  const thursday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - mondayIndex + 3);
  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * 86_400_000));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export type FateCounts = Record<Fate, number>;

export function tally(rows: readonly AdoptionRow[], key: (row: AdoptionRow) => string): Map<string, FateCounts> {
  const groups = new Map<string, FateCounts>();
  for (const row of rows) {
    const group = key(row);
    const counts = groups.get(group) ?? { addressed: 0, kept: 0, pending: 0, abandoned: 0 };
    counts[row.fate] += 1;
    groups.set(group, counts);
  }
  return groups;
}

export function adoptionRate(counts: FateCounts): number | null {
  const decided = counts.addressed + counts.kept;
  return decided === 0 ? null : counts.addressed / decided;
}

function total(counts: FateCounts): number {
  return FATES.reduce((sum, fate) => sum + counts[fate], 0);
}

function table(title: string, groups: Map<string, FateCounts>, order: (a: [string, FateCounts], b: [string, FateCounts]) => number): string[] {
  const lines = [
    `## ${title}`,
    "",
    "| group | adoption | decided | addressed | kept | pending | abandoned |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [group, c] of [...groups].sort(order)) {
    const rate = adoptionRate(c);
    const shown = rate === null ? "-" : `${Math.round(rate * 100)}%`;
    lines.push(`| ${group} | ${shown} | ${c.addressed + c.kept} | ${c.addressed} | ${c.kept} | ${c.pending} | ${c.abandoned} |`);
  }
  lines.push("");
  return lines;
}

export function renderReport(rows: readonly AdoptionRow[], since: string | null): string {
  const byTotal = (a: [string, FateCounts], b: [string, FateCounts]) => total(b[1]) - total(a[1]) || a[0].localeCompare(b[0]);
  const byName = (a: [string, FateCounts], b: [string, FateCounts]) => a[0].localeCompare(b[0]);
  const created = rows.map((r) => r.created).sort();
  const window = created.length > 0 ? `${created[0]} to ${created[created.length - 1]}` : "no finding threads";
  return [
    "# Needlefish real-PR adoption",
    "",
    `${rows.length} finding threads, ${window}${since ? ` (since ${since})` : ""}.`,
    "Addressed = GitHub marked the thread outdated before merge. Adoption = addressed / (addressed + kept), merged PRs only.",
    "",
    ...table("Overall", tally(rows, () => "all"), byName),
    ...table("By repo", tally(rows, (r) => r.repo), byTotal),
    ...table("By severity", tally(rows, (r) => r.severity), byName),
    ...table("By category", tally(rows, (r) => r.category), byTotal),
    ...table("By ISO week", tally(rows, (r) => isoWeek(r.created)), byName),
  ].join("\n");
}

// --- I/O below: gh graphql paging. Covered by the stub-gh CLI test. ---

const QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 40, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number state merged updatedAt
        reviews(last: 50) { nodes { body } }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            isOutdated isResolved path
            comments(first: 1) { nodes { author { login } body createdAt } }
          }
        }
      }
    }
  }
}`;

function fetchPage(repo: string, after: string | null): PrPage {
  const [owner, name] = repo.split("/");
  const args = ["api", "graphql", "-f", `query=${QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
  if (after) args.push("-F", `after=${after}`);
  const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`gh api graphql for ${repo} failed: ${res.stderr.trim()}`);
  return parsePrPage(JSON.parse(res.stdout));
}

// PRs are paged by last update, newest first. A thread created on or after
// --since bumps its PR's updatedAt past --since, so the first older PR ends
// the scan without missing any thread in the window.
function collect(repo: string, since: string | null): AdoptionRow[] {
  const rows: AdoptionRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page = fetchPage(repo, after);
    for (const pr of page.prs) {
      if (since !== null && pr.updatedAt < since) return rows;
      if (pr.threadsTruncated) {
        process.stderr.write(`adoption: ${repo}#${pr.number} has more than 100 review threads; only the first 100 are counted\n`);
      }
      rows.push(...rowsFromPr(repo, pr, since));
    }
    if (page.endCursor === null) return rows;
    after = page.endCursor;
  }
}

function main(): void {
  const parsed = parseCliArgs(process.argv.slice(2));
  if ("help" in parsed) {
    process.stdout.write(USAGE);
    return;
  }
  const rows: AdoptionRow[] = [];
  for (const repo of parsed.repos) {
    const got = collect(repo, parsed.since);
    process.stderr.write(`adoption: ${repo}: ${got.length} finding threads\n`);
    rows.push(...got);
  }
  process.stdout.write(parsed.json ? `${JSON.stringify(rows, null, 2)}\n` : renderReport(rows, parsed.since));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`adoption failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}
