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

function marker(findings: readonly { title: string; category: string }[]): string {
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

function prNode(fields: { number: number; state?: string; merged?: boolean; updatedAt?: string; reviews?: string[]; threads?: unknown[] }): unknown {
  return {
    number: fields.number,
    state: fields.state ?? "MERGED",
    merged: fields.merged ?? true,
    updatedAt: fields.updatedAt ?? "2026-09-20T00:00:00Z",
    reviews: { nodes: (fields.reviews ?? []).map((body) => ({ body })) },
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

test("rowsFromPr: category from header, then latest round-state marker, else unknown", () => {
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
      ["P2", "boundary", "addressed"],
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
  assert.throws(() => parsePrPage({ errors: [{ message: "rate limited" }] }), /data/);
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

function runCli(args: readonly string[]): { status: number | null; stdout: string; stderr: string; calls: string } {
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
if (args[0] !== "api" || args[1] !== "graphql" || !args.includes("owner=o") || !args.includes("name=a")) process.exit(3);
const after = args.find((a) => a.startsWith("after="));
if (after === "after=c2") { process.stderr.write("third page must not be requested\\n"); process.exit(4); }
process.stdout.write(JSON.stringify(after === "after=c1" ? ${JSON.stringify(pages.second)} : ${JSON.stringify(pages.first)}));
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
