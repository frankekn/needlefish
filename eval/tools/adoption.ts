import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTitle, parseState } from "../../src/adapters/github";
import { enrichAdoptionRows, findingIdentity, measurementOptions, renderMeasurementReport, type FindingIdentity, type FindingMeasurement, type MeasurementContract } from "./adoption-measurements.js";

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
  readonly measurement?: FindingMeasurement;
}

export interface CliArgs {
  readonly repos: readonly string[];
  readonly since: string | null;
  readonly json: boolean;
  readonly measurements?: MeasurementContract;
}

const USAGE = `Usage: npx tsx eval/tools/adoption.ts owner/name [owner/name ...] [--since YYYY-MM-DD] [--json]

Real-PR adoption of Needlefish inline findings. A finding thread counts as
addressed when GitHub marks it outdated (its lines changed after posting).
Only merged PRs are decided; open PRs are pending, closed-unmerged PRs are
abandoned. Reads GitHub through \`gh api graphql\`.

  --since  only count finding threads created on or after this UTC date
  --json   print the raw per-thread rows as JSON instead of the Markdown report
  --measurement-workflow PATH  opt in to output-only measurement collection
  --measurement-job-key KEY    exact producer workflow job key
  --measurement-job-name NAME  exact Jobs API display name
  --help   print this message and exit
`;

export function parseCliArgs(argv: readonly string[]): CliArgs | { readonly help: true } {
  if (argv.includes("--help")) return { help: true };
  const repos: string[] = [];
  let since: string | null = null;
  let json = false;
  const measurementFlags: string[] = [];
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
    } else if (["--measurement-workflow", "--measurement-job-key", "--measurement-job-name"].includes(arg)) {
      const value = argv[++i];
      if (!value) throw new Error("missing measurement option");
      measurementFlags.push(arg, value);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else if (/^[\w.-]+\/[\w.-]+$/.test(arg)) {
      repos.push(arg);
    } else {
      throw new Error(`repository must be owner/name, got: ${arg}`);
    }
  }
  if (repos.length === 0) throw new Error("at least one owner/name repository is required");
  return { repos, since, json, ...(measurementFlags.length ? { measurements: measurementOptions(measurementFlags) } : {}) };
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
  readonly identity?: FindingIdentity | null;
}

export interface PrNode {
  readonly number: number;
  readonly state: string;
  readonly merged: boolean;
  readonly updatedAt: string;
  readonly reviewBodies: readonly string[];
  readonly stateReviewIds: readonly string[];
  readonly reviewBefore: string | null;
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
    identity: findingIdentity(comment),
  };
}

function parseReviews(raw: unknown): Pick<PrNode, "reviewBodies" | "stateReviewIds" | "reviewBefore"> {
  const reviewConn = record(raw, "pullRequest.reviews");
  const stateReviewIds: string[] = [];
  const reviewBodies = nodes(reviewConn, "pullRequest.reviews").map((r) => {
    const review = record(r, "review");
    const body = typeof review.body === "string" ? review.body : "";
    if (parseState(body)) stateReviewIds.push(str(review, "id", "review"));
    return body;
  });
  const pageInfo = record(reviewConn.pageInfo, "reviews.pageInfo");
  const reviewBefore = bool(pageInfo, "hasPreviousPage", "reviews.pageInfo")
    ? str(pageInfo, "startCursor", "reviews.pageInfo") : null;
  if (reviewBefore === "") throw new Error("expected a non-empty previous-page cursor");
  return { reviewBodies, stateReviewIds, reviewBefore };
}

function parsePr(raw: unknown): PrNode {
  const pr = record(raw, "pullRequest");
  const number = pr.number;
  if (typeof number !== "number") throw new Error("expected pullRequest.number to be a number");
  const threadConn = record(pr.reviewThreads, "pullRequest.reviewThreads");
  const threads = nodes(threadConn, "pullRequest.reviewThreads")
    .map(parseThread)
    .filter((t): t is ThreadNode => t !== null);
  return {
    number,
    state: str(pr, "state", "pullRequest"),
    merged: bool(pr, "merged", "pullRequest"),
    updatedAt: str(pr, "updatedAt", "pullRequest"),
    ...parseReviews(pr.reviews),
    threads,
    threadsTruncated: bool(record(threadConn.pageInfo, "reviewThreads.pageInfo"), "hasNextPage", "reviewThreads.pageInfo"),
  };
}

export function parsePrPage(raw: unknown): PrPage {
  const data = responseData(raw);
  const conn = record(record(data.repository, "data.repository").pullRequests, "repository.pullRequests");
  const pageInfo = record(conn.pageInfo, "pullRequests.pageInfo");
  return {
    prs: nodes(conn, "pullRequests").map(parsePr),
    endCursor: nextCursor(pageInfo),
  };
}

function stateCategories(reviewBodies: readonly string[]): Map<string, Set<string>> {
  const categories = new Map<string, Set<string>>();
  for (const body of reviewBodies) {
    for (const key of parseState(body)?.findings ?? []) {
      const identity = JSON.stringify([key.file, key.title]);
      const matches = categories.get(identity) ?? new Set<string>();
      matches.add(key.category);
      categories.set(identity, matches);
    }
  }
  return categories;
}

export function rowsFromPr(repo: string, pr: PrNode, since: string | null, captureIdentity = false): AdoptionRow[] {
  const categories = stateCategories(pr.reviewBodies);
  const rows: AdoptionRow[] = [];
  for (const thread of pr.threads) {
    if (since !== null && thread.createdAt < since) continue;
    const header = parseFindingHeader(thread.body);
    if (!header) continue;
    const matches = categories.get(JSON.stringify([thread.path, normalizeTitle(header.title)]));
    const category = matches?.size === 1 ? [...matches][0] : "unknown";
    rows.push({
      repo,
      pr: pr.number,
      severity: header.severity,
      category: header.category ?? category,
      fate: classifyFate(pr, thread.isOutdated),
      resolved: thread.isResolved,
      path: thread.path,
      created: thread.createdAt,
      author: thread.author,
      ...(captureIdentity ? { measurement: { status: "unknown" as const, identity: thread.identity ?? null, reason: "not_collected" } } : {}),
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
    ...renderMeasurementReport(rows),
  ].join("\n");
}

// --- I/O below: gh graphql paging. Covered by the stub-gh CLI test. ---

const QUERY = `query($owner: String!, $name: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 40, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        number state merged updatedAt
        reviews(last: 50) { pageInfo { hasPreviousPage startCursor } nodes { id body } }
        reviewThreads(first: 100) {
          pageInfo { hasNextPage }
          nodes {
            isOutdated isResolved path
            comments(first: 1) { nodes { author { login } body createdAt databaseId originalCommit { oid } pullRequestReview { databaseId } } }
          }
        }
      }
    }
  }
}`;

const REVIEWS_QUERY = `query($owner: String!, $name: String!, $pr: Int!, $before: String!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviews(last: 50, before: $before) {
        pageInfo { hasPreviousPage startCursor }
        nodes { id body }
      }
    }
  }
}`;

const HISTORY_QUERY = `query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReview {
      userContentEdits(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { deletedAt diff }
      }
    }
  }
}`;

function responseData(raw: unknown): JsonRecord {
  const response = record(raw, "graphql response");
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error(`GitHub GraphQL errors: ${JSON.stringify(response.errors)}`);
  }
  return record(response.data, "data");
}

function nextCursor(pageInfo: JsonRecord): string | null {
  if (!bool(pageInfo, "hasNextPage", "pageInfo")) return null;
  const cursor = str(pageInfo, "endCursor", "pageInfo");
  if (!cursor) throw new Error("expected a non-empty next-page cursor");
  return cursor;
}

function graphql(repo: string, query: string, fields: readonly string[]): unknown {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const field of fields) args.push("-F", field);
  const res = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1024 * 1024 * 64 });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`gh api graphql for ${repo} failed: ${res.stderr.trim()}`);
  return JSON.parse(res.stdout);
}

function fetchPage(repo: string, after: string | null): PrPage {
  const [owner, name] = repo.split("/");
  const fields = [`owner=${owner}`, `name=${name}`];
  if (after) fields.push(`after=${after}`);
  return parsePrPage(graphql(repo, QUERY, fields));
}

function historyBodies(repo: string, pr: PrNode): string[] {
  const bodies: string[] = [];
  for (const id of pr.stateReviewIds) {
    let after: string | null = null;
    const cursors = new Set<string>();
    let unavailable = 0;
    for (;;) {
      const fields = [`id=${id}`];
      if (after) fields.push(`after=${after}`);
      const data = responseData(graphql(repo, HISTORY_QUERY, fields));
      const edits = data.node === null ? null : record(data.node, "review").userContentEdits;
      if (edits === null) {
        process.stderr.write(`adoption: ${repo}#${pr.number} review ${id} history unavailable\n`);
        break;
      }
      const conn = record(edits, "userContentEdits");
      for (const raw of nodes(conn, "userContentEdits")) {
        if (raw === null) {
          unavailable++;
          continue;
        }
        const edit = record(raw, "userContentEdit");
        if (edit.deletedAt === null && typeof edit.diff === "string" && parseState(edit.diff)) {
          bodies.push(edit.diff);
        } else {
          unavailable++;
        }
      }
      after = nextCursor(record(conn.pageInfo, "userContentEdits.pageInfo"));
      if (after === null) break;
      if (cursors.has(after)) throw new Error(`repeated history cursor for ${repo}#${pr.number} review ${id}`);
      cursors.add(after);
    }
    if (unavailable > 0) {
      process.stderr.write(`adoption: ${repo}#${pr.number} review ${id}: ${unavailable} edits unavailable or without valid state\n`);
    }
  }
  return bodies;
}

function recoverCategories(repo: string, pr: PrNode, since: string | null, captureIdentity: boolean): AdoptionRow[] {
  const [owner, name] = repo.split("/");
  const reviewBodies = [...pr.reviewBodies];
  const stateReviewIds = [...pr.stateReviewIds];
  let before = pr.reviewBefore;
  const cursors = new Set<string>();
  while (before !== null) {
    if (cursors.has(before)) throw new Error(`repeated reviews cursor for ${repo}#${pr.number}`);
    cursors.add(before);
    const data = responseData(graphql(repo, REVIEWS_QUERY, [
      `owner=${owner}`, `name=${name}`, `pr=${pr.number}`, `before=${before}`,
    ]));
    const pullRequest = record(record(data.repository, "repository").pullRequest, "pullRequest");
    const previous = parseReviews(pullRequest.reviews);
    reviewBodies.push(...previous.reviewBodies);
    stateReviewIds.push(...previous.stateReviewIds);
    before = previous.reviewBefore;
  }
  const complete = { ...pr, reviewBodies, stateReviewIds };
  reviewBodies.push(...historyBodies(repo, complete));
  return rowsFromPr(repo, complete, since, captureIdentity);
}

// PRs are paged by last update, newest first. A thread created on or after
// --since bumps its PR's updatedAt past --since, so the first older PR ends
// the scan without missing any thread in the window.
function collect(repo: string, since: string | null, captureIdentity: boolean): AdoptionRow[] {
  const rows: AdoptionRow[] = [];
  let after: string | null = null;
  for (;;) {
    const page = fetchPage(repo, after);
    for (const pr of page.prs) {
      if (since !== null && pr.updatedAt < since) return rows;
      if (pr.threadsTruncated) {
        process.stderr.write(`adoption: ${repo}#${pr.number} has more than 100 review threads; only the first 100 are counted\n`);
      }
      const needsState = pr.threads.some((thread) =>
        (since === null || thread.createdAt >= since) && parseFindingHeader(thread.body)?.category === null);
      if (needsState) {
        rows.push(...recoverCategories(repo, pr, since, captureIdentity));
      } else {
        rows.push(...rowsFromPr(repo, pr, since, captureIdentity));
      }
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
  const deadline = performance.now() + 9 * 60 * 1000;
  const rows: AdoptionRow[] = [];
  for (const repo of parsed.repos) {
    const collected = collect(repo, parsed.since, parsed.measurements !== undefined);
    const got = parsed.measurements ? enrichAdoptionRows(collected, parsed.measurements, undefined, deadline) : collected;
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
