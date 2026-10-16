import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  adoptionRate,
  classifyFate,
  isoWeek,
  parseCliArgs,
  parseFindingHeader,
  parsePrPage,
  renderReport,
  rowsFromPr,
  tally,
  type AdoptionRow,
} from "./adoption";

function marker(findings: readonly { title: string; category: string; file?: string }[]): string {
  const keys = findings.map((f) => ({ file: "src/a.ts", lineStart: 1, ...f }));
  return `summary\n\n<!-- needlefish-state: ${JSON.stringify({ v: 1, headSha: "abc", findings: keys })} -->`;
}

function thread(body: string, opts: { outdated?: boolean; created?: string } = {}): unknown {
  return {
    isOutdated: opts.outdated ?? false,
    isResolved: false,
    path: "src/a.ts",
    comments: { nodes: [{ author: { login: "github-actions" }, body, createdAt: opts.created ?? "2026-09-10T12:00:00Z" }] },
  };
}

function prNode(fields: { number: number; state?: string; merged?: boolean; updatedAt?: string; reviews?: string[]; threads?: unknown[]; reviewsTruncated?: boolean }) {
  return {
    number: fields.number,
    state: fields.state ?? "MERGED",
    merged: fields.merged ?? true,
    updatedAt: fields.updatedAt ?? "2026-09-20T00:00:00Z",
    reviews: { pageInfo: { hasPreviousPage: fields.reviewsTruncated ?? false, startCursor: fields.reviewsTruncated ? "reviews-2" : null }, nodes: (fields.reviews ?? []).map((body, index) => ({ id: `R${fields.number}-${index}`, body })) },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: fields.threads ?? [] },
  };
}

function page(prs: unknown[], endCursor: string | null): unknown {
  return { data: { repository: { pullRequests: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes: prs } } } };
}

test("parseCliArgs: repos come only from argv, with --since and --json", () => {
  assert.deepEqual(parseCliArgs(["o/a", "--since", "2026-09-01", "o/b.js", "--json"]), {
    repos: ["o/a", "o/b.js"],
    since: "2026-09-01",
    json: true,
  });
  assert.deepEqual(parseCliArgs(["o/a"]), { repos: ["o/a"], since: null, json: false });
  assert.deepEqual(parseCliArgs(["--help"]), { help: true });
});

test("parseCliArgs: rejects a missing repo list, bad repo, bad date, unknown flag", () => {
  assert.throws(() => parseCliArgs([]), /at least one owner\/name/);
  assert.throws(() => parseCliArgs(["--json"]), /at least one owner\/name/);
  assert.throws(() => parseCliArgs(["justname"]), /owner\/name/);
  assert.throws(() => parseCliArgs(["o/a", "--since", "09/01/2026"]), /--since must be a YYYY-MM-DD/);
  assert.throws(() => parseCliArgs(["o/a", "--since"]), /--since must be a YYYY-MM-DD/);
  assert.throws(() => parseCliArgs(["o/a", "--limit", "3"]), /unknown option: --limit/);
});

test("parseFindingHeader: current header has severity and title, no category", () => {
  assert.deepEqual(parseFindingHeader("**P2** Guard the empty list\n\nwhy\n\n**Fix:** fix"), {
    severity: "P2",
    title: "Guard the empty list",
    category: null,
  });
});

test("parseFindingHeader: legacy header carries the category", () => {
  assert.deepEqual(parseFindingHeader("**P1 (validation): Reject a negative count**\n\nwhy"), {
    severity: "P1",
    title: "Reject a negative count",
    category: "validation",
  });
});

test("parseFindingHeader: non-finding comments are not counted", () => {
  assert.equal(parseFindingHeader("Thanks, fixed in abc123."), null);
  assert.equal(parseFindingHeader("**Fix:** do the thing"), null);
  assert.equal(parseFindingHeader("**P4** not a severity"), null);
  assert.equal(parseFindingHeader("see **P2** below"), null);
});

test("classifyFate: only merged PRs are decided", () => {
  assert.equal(classifyFate({ state: "MERGED", merged: true }, true), "addressed");
  assert.equal(classifyFate({ state: "MERGED", merged: true }, false), "kept");
  assert.equal(classifyFate({ state: "OPEN", merged: false }, true), "pending");
  assert.equal(classifyFate({ state: "OPEN", merged: false }, false), "pending");
  assert.equal(classifyFate({ state: "CLOSED", merged: false }, true), "abandoned");
});

test("rowsFromPr: category from header, then unambiguous path and title, else unknown", () => {
  const { prs } = parsePrPage(
    page(
      [
        prNode({
          number: 7,
          reviews: [
            marker([{ title: "guard the empty list", category: "bug" }]),
            marker([{ title: "guard the empty list", category: "boundary" }]),
          ],
          threads: [
            thread("**P2** Guard the   EMPTY list\n\nwhy", { outdated: true }),
            thread("**P1 (security): Strip the token**"),
            thread("**P3** Unmatched title"),
            thread("a human reply"),
            { isOutdated: false, isResolved: false, path: "x", comments: { nodes: [] } },
          ],
        }),
      ],
      null,
    ),
  );
  const rows = rowsFromPr("o/a", prs[0], null);
  assert.deepEqual(
    rows.map((r) => [r.severity, r.category, r.fate]),
    [
      ["P2", "unknown", "addressed"],
      ["P1", "security", "kept"],
      ["P3", "unknown", "kept"],
    ],
  );
  assert.equal(rows[0].repo, "o/a");
  assert.equal(rows[0].pr, 7);
  assert.equal(rows[0].author, "github-actions");
});

test("rowsFromPr: --since drops threads created before the window", () => {
  const { prs } = parsePrPage(
    page(
      [
        prNode({
          number: 1,
          threads: [
            thread("**P2** old", { created: "2026-08-31T23:59:59Z" }),
            thread("**P2** on the day", { created: "2026-09-01T00:00:00Z" }),
          ],
        }),
      ],
      null,
    ),
  );
  assert.deepEqual(
    rowsFromPr("o/a", prs[0], "2026-09-01").map((r) => r.created),
    ["2026-09-01T00:00:00Z"],
  );
});

test("parsePrPage: malformed GitHub responses throw instead of counting nothing", () => {
  assert.throws(() => parsePrPage({ errors: [{ message: "rate limited" }] }), /GraphQL errors.*rate limited/);
  assert.throws(() => parsePrPage(page([{ number: "7" }], null)), /pullRequest\.number/);
  assert.throws(() => parsePrPage(page([prNode({ number: 1, threads: [{ isOutdated: "yes" }] })], null)), /reviewThread/);
});

test("parsePrPage: end cursor only when another page exists", () => {
  assert.equal(parsePrPage(page([], "c1")).endCursor, "c1");
  assert.equal(parsePrPage(page([], null)).endCursor, null);
});

test("isoWeek: ISO-8601 weeks across year boundaries", () => {
  assert.equal(isoWeek("2026-09-29T10:00:00Z"), "2026-W40");
  assert.equal(isoWeek("2026-09-27T23:59:59Z"), "2026-W39");
  assert.equal(isoWeek("2021-01-03T00:00:00Z"), "2020-W53");
  assert.equal(isoWeek("2024-12-30T00:00:00Z"), "2025-W01");
});

function row(fate: AdoptionRow["fate"], extra: Partial<AdoptionRow> = {}): AdoptionRow {
  return { repo: "o/a", pr: 1, severity: "P2", category: "bug", fate, resolved: false, path: "a", created: "2026-09-10T00:00:00Z", author: null, ...extra };
}

test("tally and adoptionRate: pending and abandoned never enter the rate", () => {
  const groups = tally([row("addressed"), row("kept"), row("kept"), row("pending"), row("abandoned")], (r) => r.severity);
  const p2 = groups.get("P2");
  assert.deepEqual(p2, { addressed: 1, kept: 2, pending: 1, abandoned: 1 });
  assert.equal(adoptionRate(p2!), 1 / 3);
  assert.equal(adoptionRate({ addressed: 0, kept: 0, pending: 3, abandoned: 1 }), null);
});

test("renderReport: splits by repo, severity, category, and ISO week", () => {
  const report = renderReport(
    [
      row("addressed"),
      row("kept", { repo: "o/b", severity: "P1", category: "security", created: "2026-09-29T00:00:00Z" }),
      row("pending", { category: "unknown" }),
    ],
    "2026-09-01",
  );
  assert.match(report, /3 finding threads, .* \(since 2026-09-01\)/);
  assert.match(report, /## Overall\n\n.*\n.*\n\| all \| 50% \| 2 \| 1 \| 1 \| 1 \| 0 \|/);
  assert.match(report, /\| o\/b \| 0% \| 1 \| 0 \| 1 \| 0 \| 0 \|/);
  assert.match(report, /\| P2 \| 100% \| 1 \| 1 \| 0 \| 1 \| 0 \|/);
  assert.match(report, /\| unknown \| - \| 0 \| 0 \| 0 \| 1 \| 0 \|/);
  assert.match(report, /\| 2026-W37 \| 100% \|/);
  assert.match(report, /\| 2026-W40 \| 0% \|/);
});

function runCli(args: readonly string[], responder?: string): { status: number | null; stdout: string; stderr: string; calls: string } {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "adoption-cli-test-"));
  const callLog = path.join(tmp, "calls.log");
  const pages = {
    first: page(
      [
        prNode({ number: 9, updatedAt: "2026-09-20T00:00:00Z", threads: [thread("**P2** new", { outdated: true, created: "2026-09-19T00:00:00Z" })] }),
      ],
      "c1",
    ),
    second: page(
      [
        prNode({ number: 8, updatedAt: "2026-09-05T00:00:00Z", threads: [thread("**P1** middle", { created: "2026-09-04T00:00:00Z" })] }),
        prNode({ number: 2, updatedAt: "2026-08-01T00:00:00Z", threads: [thread("**P3** old", { created: "2026-07-30T00:00:00Z" })] }),
      ],
      "c2",
    ),
  };
  try {
    const gh = path.join(tmp, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callLog)}, args.filter((a) => !a.startsWith("query=")).join(" ") + "\\n");
${responder ?? `if (args[0] !== "api" || args[1] !== "graphql" || !args.includes("owner=o") || !args.includes("name=a")) process.exit(3);
const after = args.find((a) => a.startsWith("after="));
if (after === "after=c2") { process.stderr.write("third page must not be requested\\n"); process.exit(4); }
process.stdout.write(JSON.stringify(after === "after=c1" ? ${JSON.stringify(pages.second)} : ${JSON.stringify(pages.first)}));`}
`,
    );
    chmodSync(gh, 0o755);
    const result = spawnSync(process.execPath, ["--import", "tsx", path.resolve("eval/tools/adoption.ts"), ...args], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${tmp}:${process.env.PATH ?? ""}` },
    });
    const calls = existsSync(callLog) ? readFileSync(callLog, "utf8") : "";
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("CLI: --since stops paging at the first PR last updated before the window", () => {
  const result = runCli(["o/a", "--since", "2026-09-01", "--json"]);
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout) as AdoptionRow[];
  assert.deepEqual(rows.map((r) => [r.repo, r.pr, r.severity, r.fate]), [
    ["o/a", 9, "P2", "addressed"],
    ["o/a", 8, "P1", "kept"],
  ]);
  assert.equal(result.calls.trim().split("\n").length, 2);
  assert.match(result.stderr, /o\/a: 2 finding threads/);
});

test("CLI: gh failure exits non-zero", () => {
  const result = runCli(["o/a"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /adoption failed: gh api graphql for o\/a failed: third page must not be requested/);
});

function editPage(bodies: readonly unknown[], endCursor: string | null = null): unknown {
  return { data: { node: { userContentEdits: {
    pageInfo: { hasNextPage: endCursor !== null, endCursor },
    nodes: bodies,
  } } } };
}

function historyResponder(prs: unknown[], first: unknown, second?: unknown): string {
  return `
const query = args.find((a) => a.startsWith("query="));
const isHistory = query.includes("userContentEdits");
if (isHistory && query.includes("pullRequests(")) process.exit(5);
const response = !isHistory ? ${JSON.stringify(page(prs, null))}
  : args.includes("after=edits-2") ? ${JSON.stringify(second ?? first)} : ${JSON.stringify(first)};
process.stdout.write(JSON.stringify(response));`;
}

test("CLI: recovers overwritten rounds across history pages without changing rows", () => {
  const pr = prNode({ number: 7, reviews: [marker([]), "human review"], threads: [
    thread("**P2** Guard the EMPTY list", { outdated: true }),
    thread("**P1** Strip the token"),
    thread("**P3** Missing history"),
    thread("**P2 (contract): Direct category**"),
  ] });
  const result = runCli(["o/a", "--json"], historyResponder([pr], editPage([
    { deletedAt: null, diff: marker([{ title: "strip the token", category: "security" }]) },
    { deletedAt: null, diff: marker([]) },
  ], "edits-2"), editPage([
    { deletedAt: null, diff: marker([{ title: "guard the empty list", category: "bug" }]) },
  ])));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { repo: "o/a", pr: 7, severity: "P2", category: "bug", fate: "addressed", resolved: false, path: "src/a.ts", created: "2026-09-10T12:00:00Z", author: "github-actions" },
    { repo: "o/a", pr: 7, severity: "P1", category: "security", fate: "kept", resolved: false, path: "src/a.ts", created: "2026-09-10T12:00:00Z", author: "github-actions" },
    { repo: "o/a", pr: 7, severity: "P3", category: "unknown", fate: "kept", resolved: false, path: "src/a.ts", created: "2026-09-10T12:00:00Z", author: "github-actions" },
    { repo: "o/a", pr: 7, severity: "P2", category: "contract", fate: "kept", resolved: false, path: "src/a.ts", created: "2026-09-10T12:00:00Z", author: "github-actions" },
  ]);
  assert.equal(result.calls.trim().split("\n").length, 3);
  assert.match(result.calls, /id=R7-0/);
  assert.match(result.calls, /after=edits-2/);
  assert.doesNotMatch(result.calls, /id=R7-1/);
});

test("CLI: history category conflicts stay unknown and path disambiguates titles", () => {
  const pr = prNode({ number: 7, reviews: [marker([{ title: "same title", category: "bug" }])], threads: [
    thread("**P2** Same title"), thread("**P1** Old title"), thread("**P3 (runtime): Same title**"),
  ] });
  const history = editPage([{ deletedAt: null, diff: marker([
    { title: "same title", category: "security" },
    { title: "old title", category: "contract" },
    { title: "old title", category: "bug", file: "src/other.ts" },
  ]) }]);
  const result = runCli(["o/a", "--json"], historyResponder([pr], history));
  assert.equal(result.status, 0, result.stderr);
  const rows: AdoptionRow[] = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((r) => r.category), ["unknown", "contract", "runtime"]);
});

for (const [name, history] of [
  ["empty", editPage([])],
  ["null connection", { data: { node: { userContentEdits: null } } }],
  ["deleted review", { data: { node: null } }],
  ["unavailable edits", editPage([
    null,
    { deletedAt: "2026-09-11T00:00:00Z", diff: marker([{ title: "old title", category: "bug" }]) },
    { deletedAt: null, diff: null },
    { deletedAt: null, diff: "<!-- needlefish-state: malformed -->" },
    { deletedAt: null, diff: "ordinary review text" },
  ])],
] as const) {
  test(`CLI: ${name} history retains unknown categories`, () => {
    const pr = prNode({ number: 7, reviews: [marker([])], threads: [thread("**P2** Old title")] });
    const result = runCli(["o/a", "--json"], historyResponder([pr], history));
    assert.equal(result.status, 0, result.stderr);
    const rows: AdoptionRow[] = JSON.parse(result.stdout);
    assert.deepEqual(rows.map((r) => r.category), ["unknown"]);
    if (name !== "empty") assert.match(result.stderr, /history.*unavailable|edits.*without valid state/);
  });
}

for (const [name, history] of [
  ["GraphQL errors with partial data", { data: { node: null }, errors: [{ message: "forbidden" }] }],
  ["missing next cursor", { data: { node: { userContentEdits: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } } } } }],
  ["invalid edit", editPage([42])],
  ["repeated cursor", editPage([], "edits-2")],
] as const) {
  test(`CLI: rejects ${name} instead of reporting complete history`, () => {
    const pr = prNode({ number: 7, reviews: [marker([])], threads: [thread("**P2** Old title")] });
    const result = runCli(["o/a", "--json"], historyResponder([pr], history));
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /adoption failed/);
  });
}

test("CLI: history API failure fails the report", () => {
  const pr = prNode({ number: 7, reviews: [marker([])], threads: [thread("**P2** Old title")] });
  const result = runCli(["o/a", "--json"], `
if (args.some((a) => a.startsWith("id="))) { process.stderr.write("rate limited"); process.exit(1); }
process.stdout.write(${JSON.stringify(JSON.stringify(page([pr], null)))});`);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /rate limited/);
  assert.equal(result.stdout, "");
});

test("CLI: known categories are checked against matching history", () => {
  const pr = prNode({ number: 7, reviews: [marker([{ title: "known", category: "bug" }])], threads: [
    thread("**P2** Known"), thread("**P1** Old", { created: "2026-08-01T00:00:00Z" }),
  ] });
  const result = runCli(["o/a", "--since", "2026-09-01", "--json"], historyResponder([pr], editPage([
    { deletedAt: null, diff: marker([{ title: "known", category: "bug" }]) },
  ])));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.trim().split("\n").length, 2);
  const rows: AdoptionRow[] = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((r) => r.category), ["bug"]);
});

test("CLI: finds the state review beyond the latest 50 reviews", () => {
  const pr = prNode({ number: 7, reviewsTruncated: true, reviews: ["human review"], threads: [thread("**P2** Old title")] });
  const older = { data: { repository: { pullRequest: { reviews: {
    pageInfo: { hasPreviousPage: false, startCursor: null },
    nodes: [{ id: "original-state", body: marker([]) }],
  } } } } };
  const history = editPage([{ deletedAt: null, diff: marker([{ title: "old title", category: "contract" }]) }]);
  const result = runCli(["o/a", "--json"], `
const response = args.includes("before=reviews-2") ? ${JSON.stringify(older)}
  : args.includes("id=original-state") ? ${JSON.stringify(history)} : ${JSON.stringify(page([pr], null))};
process.stdout.write(JSON.stringify(response));`);
  assert.equal(result.status, 0, result.stderr);
  const rows: AdoptionRow[] = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((r) => r.category), ["contract"]);
  assert.equal(result.calls.trim().split("\n").length, 3);
  assert.match(result.calls, /before=reviews-2/);
  assert.match(result.calls, /id=original-state/);
});

for (const [name, previous] of [
  ["missing previous cursor", { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: null } }],
  ["repeated previous cursor", { nodes: [], pageInfo: { hasPreviousPage: true, startCursor: "reviews-2" } }],
] as const) {
  test(`CLI: rejects ${name} in older reviews`, () => {
    const pr = prNode({ number: 7, reviewsTruncated: true, threads: [thread("**P2** Old title")] });
    const older = { data: { repository: { pullRequest: { reviews: previous } } } };
    const result = runCli(["o/a", "--json"], `
process.stdout.write(JSON.stringify(args.includes("before=reviews-2")
  ? ${JSON.stringify(older)} : ${JSON.stringify(page([pr], null))}));`);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /adoption failed/);
  });
}

test("CLI: reports a truncated thread window while retaining captured rows", () => {
  const pr = {
    ...prNode({ number: 7, reviews: [] }),
    reviewThreads: { pageInfo: { hasNextPage: true }, nodes: [thread("**P1 (security): Strip the token**")] },
  };
  const result = runCli(["o/a", "--json"], historyResponder([pr], editPage([])));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /only the first 100 are counted/);
  const rows: AdoptionRow[] = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((r) => [r.severity, r.category]), [["P1", "security"]]);
});

test("CLI: checks history conflicts even when an older current marker supplies the category", () => {
  const pr = prNode({ number: 7, reviewsTruncated: true, threads: [thread("**P2** Old title")] });
  const older = { data: { repository: { pullRequest: { reviews: {
    pageInfo: { hasPreviousPage: false, startCursor: null },
    nodes: [{ id: "original-state", body: marker([{ title: "old title", category: "bug" }]) }],
  } } } } };
  const history = editPage([{ deletedAt: null, diff: marker([{ title: "old title", category: "contract" }]) }]);
  const result = runCli(["o/a", "--json"], `
const response = args.includes("before=reviews-2") ? ${JSON.stringify(older)}
  : args.includes("id=original-state") ? ${JSON.stringify(history)} : ${JSON.stringify(page([pr], null))};
process.stdout.write(JSON.stringify(response));`);
  assert.equal(result.status, 0, result.stderr);
  const rows: AdoptionRow[] = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((r) => r.category), ["unknown"]);
  assert.equal(result.calls.trim().split("\n").length, 3);
});

test("CLI: a known current category becomes unknown when history conflicts", () => {
  const pr = prNode({ number: 7, reviews: [marker([{ title: "known", category: "bug" }])], threads: [
    thread("**P2** Known"), thread("**P1 (security): Known**"),
  ] });
  const result = runCli(["o/a", "--json"], historyResponder([pr], editPage([
    { deletedAt: null, diff: marker([{ title: "known", category: "contract" }]) },
  ])));
  assert.equal(result.status, 0, result.stderr);
  const rows: AdoptionRow[] = JSON.parse(result.stdout);
  assert.deepEqual(rows.map((r) => r.category), ["unknown", "security"]);
  assert.equal(result.calls.trim().split("\n").length, 2);
});

for (const [name, threads, expected] of [
  ["explicit categories", [thread("**P2 (security): Known**")], ["security"]],
  ["non-finding comments", [thread("Thanks, fixed.")], []],
  ["excluded old findings", [thread("**P2** Known", { created: "2026-08-01T00:00:00Z" })], []],
] as const) {
  test(`CLI: ${name} do not fetch older reviews or history`, () => {
    const pr = prNode({ number: 7, reviewsTruncated: true, reviews: [marker([{ title: "known", category: "bug" }])], threads: [...threads] });
    const result = runCli(["o/a", "--since", "2026-09-01", "--json"], historyResponder([pr], editPage([
      { deletedAt: null, diff: marker([{ title: "known", category: "contract" }]) },
    ])));
    assert.equal(result.status, 0, result.stderr);
    const rows: AdoptionRow[] = JSON.parse(result.stdout);
    assert.deepEqual(rows.map((r) => r.category), expected);
    assert.equal(result.calls.trim().split("\n").length, 1);
  });
}
