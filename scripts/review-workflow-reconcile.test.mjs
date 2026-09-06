import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The reconcile job is the only thing that can re-dispatch a review on its
// own, so an unbounded branch here is an unbounded model-call loop. On
// 2026-09-05 one usage-limited review produced 71 re-dispatches in 52 minutes
// because the retry cap counted check-runs through the API's default
// filter=latest (one check-run per name) and the active-run guard matched a
// workflow name this repo does not use. Each branch below runs the real
// script against a stub gh that serves canned responses per endpoint.

const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const step = workflow.match(
	/      - name: Re-dispatch when the latest head lacks a terminal result\n([\s\S]*?)(?=\n      - name:|$)/,
);
assert.ok(step, "reconcile step must exist");
const runBlock = step[1].match(/        run: \|\n([\s\S]*)/);
assert.ok(runBlock, "reconcile step must have a run block");
const scriptLines = [];
for (const line of runBlock[1].split("\n")) {
	if (line.length > 0 && !line.startsWith("          ")) break;
	scriptLines.push(line);
}
const script = scriptLines.map((line) => line.replace(/^          /, "")).join("\n");

const REPO = "acme/widgets";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const SELF_RUN_ID = "777";

function checkRun(title, conclusion = "failure") {
	return { conclusion, output: { title } };
}

function activeRun(id, title) {
	return { id, display_title: title };
}

// Canned responses keyed by the substring of the API path that identifies the
// endpoint. Order matters: first match wins.
function runReconcile({
	prNum = "42",
	state = "open",
	headRepo = REPO,
	checkRunsAll = [],
	checkRunsLatest = null,
	activeRuns = [],
	completedRuns = [],
	workflowMissing = false,
	workflowRef = `${REPO}/.github/workflows/review.yml@refs/heads/main`,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-reconcile-"));
	const fakeBin = join(root, "fake-bin");
	const ghLog = join(root, "gh.log");
	mkdirSync(fakeBin);
	const latest =
		checkRunsLatest ??
		// GitHub's default filter=latest: one run per check name, the newest.
		(checkRunsAll.length > 0 ? [checkRunsAll[checkRunsAll.length - 1]] : []);
	const responses = {
		pulls: JSON.stringify({ state, head: { sha: HEAD, repo: { full_name: headRepo } } }),
		checkRunsAll: JSON.stringify({ check_runs: checkRunsAll }),
		checkRunsLatest: JSON.stringify({ check_runs: latest }),
		activeRuns: JSON.stringify({ workflow_runs: activeRuns }),
		completedRuns: JSON.stringify({ workflow_runs: completedRuns }),
		workflow: JSON.stringify({ id: 1, path: ".github/workflows/review.yml" }),
		repo: JSON.stringify({ default_branch: "main" }),
	};
	writeFileSync(join(root, "responses.json"), JSON.stringify(responses));
	writeFileSync(
		join(fakeBin, "gh"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
pick() { node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r[process.argv[2]])' "$RESPONSES" "$1"; }
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then
  echo "dispatched" >> "$GH_LOG"
  exit 0
fi
if [ "$1" != "api" ]; then echo "unexpected gh $*" >&2; exit 2; fi
shift
jq_filter=""
path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_filter="$2"; shift 2 ;;
    -X|-f) shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  *"/check-runs?"*"filter=all"*) body=$(pick checkRunsAll) ;;
  *"/check-runs?"*) body=$(pick checkRunsLatest) ;;
  repos/*/check-runs) body='{}' ;;
  *"/actions/workflows/"*"/runs?status=completed&per_page=100") body=$(pick completedRuns) ;;
  *"/actions/workflows/"*"/runs?"*) body=$(pick activeRuns) ;;
  *"/actions/runs?"*) body='{"workflow_runs": []}' ;;
  *"/actions/workflows/"*)
    if [ "$WORKFLOW_MISSING" = "1" ]; then echo "HTTP 404" >&2; exit 1; fi
    body=$(pick workflow) ;;
  *"/pulls/"*) body=$(pick pulls) ;;
  repos/*) body=$(pick repo) ;;
  *) echo "unexpected api path $path" >&2; exit 2 ;;
esac
if [ -n "$jq_filter" ]; then printf '%s' "$body" | jq -r "$jq_filter"; else printf '%s\\n' "$body"; fi
`,
	);
	chmodSync(join(fakeBin, "gh"), 0o755);
	const result = spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			GH_LOG: ghLog,
			GH_TOKEN: "test-token",
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			PR_NUM: prNum,
			REPO,
			RESPONSES: join(root, "responses.json"),
			RUN_ID: SELF_RUN_ID,
			WORKFLOW_REF: workflowRef,
			WORKFLOW_MISSING: workflowMissing ? "1" : "0",
		},
	});
	const log = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
	rmSync(root, { recursive: true, force: true });
	return {
		status: result.status,
		stdout: result.stdout,
		stderr: result.stderr,
		dispatched: log.split("\n").filter((line) => line === "dispatched").length,
		log,
	};
}

const INFRA = checkRun("Needlefish: review failed");

test("workflow shape: run-name carries the PR number and check-runs are read with filter=all", () => {
	assert.match(
		workflow,
		/^run-name: "needlefish-review PR #\$\{\{ inputs\.pr_number \|\| github\.event\.inputs\.pr_number \|\| github\.event\.pull_request\.number \}\}"$/m,
	);
	assert.match(script, /check-runs\?check_name=Needlefish&per_page=100&filter=all/);
	assert.doesNotMatch(script, /actions\/runs\?head_sha=/);
	assert.doesNotMatch(script, /select\(\.name == "needlefish"\)/);
});

test("reconcile re-dispatches once when the head has a single infra failure", () => {
	const r = runReconcile({ checkRunsAll: [INFRA] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.match(r.stdout, /reconciliation dispatched for PR #42/);
});

test("reconcile stops at the retry cap even though filter=latest shows one failure", () => {
	// Two prior infra failures on the head. The default filter would report
	// only the newest one (see checkRunsLatest derivation) and re-dispatch
	// forever; with filter=all the cap trips.
	const r = runReconcile({ checkRunsAll: [INFRA, INFRA] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /retry cap reached/);
});

test("reconcile does not re-dispatch a head that already has a verdict", () => {
	const r = runReconcile({
		checkRunsAll: [INFRA, checkRun("Needlefish: pass", "success")],
	});
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /already has a terminal Needlefish verdict/);
});

test("reconcile treats a non-infra failure as a terminal verdict", () => {
	const r = runReconcile({
		checkRunsAll: [checkRun("Needlefish: changes_requested — Fix the thing", "failure")],
	});
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /already has a terminal Needlefish verdict/);
});

test("reconcile waits for an active run of the same workflow for the same PR", () => {
	const r = runReconcile({
		checkRunsAll: [INFRA],
		activeRuns: [activeRun(900, "needlefish-review PR #42")],
	});
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /still active or queued/);
});

test("reconcile ignores its own run and runs for other PRs when counting active runs", () => {
	const r = runReconcile({
		checkRunsAll: [INFRA],
		activeRuns: [
			activeRun(Number(SELF_RUN_ID), "needlefish-review PR #42"),
			activeRun(901, "needlefish-review PR #420"),
			activeRun(902, "needlefish-review PR #7"),
		],
	});
	assert.equal(r.dispatched, 1, r.stdout + r.stderr);
});

test("reconcile skips closed PRs", () => {
	const r = runReconcile({ state: "closed", checkRunsAll: [INFRA] });
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /is closed; nothing to reconcile/);
});

test("reconcile skips fork PRs even with no terminal result", () => {
	const r = runReconcile({ headRepo: "someone/widgets", checkRunsAll: [] });
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /fork reviews are skipped/);
});

test("reconcile does nothing without a PR number", () => {
	const r = runReconcile({ prNum: "" });
	assert.equal(r.status, 0);
	assert.equal(r.dispatched, 0);
	assert.doesNotMatch(r.log, /api/);
});

test("reconcile reports a missing caller workflow before querying its runs", () => {
	const r = runReconcile({ workflowMissing: true });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	const posts = r.log.split("\n").filter((line) => line.startsWith("api -X POST "));
	assert.equal(posts.length, 1);
	assert.match(posts[0], /check-runs .*output\[title\]=Needlefish: caller retry required/);
	assert.doesNotMatch(r.log, /actions\/workflows\/review.yml\/runs\?/);
});

test("reconcile rejects a PR number containing regex syntax before any API call", () => {
	const r = runReconcile({ prNum: "42|.*" });
	assert.equal(r.status, 1);
	assert.match(r.stdout, /PR number must be a positive integer/);
	assert.equal(r.dispatched, 0);
	assert.doesNotMatch(r.log, /api/);
});

test("reconcile caps three completed failed runs before any check-run exists", () => {
	const r = runReconcile({
		completedRuns: [1, 2, 3].map((id) => ({
			...activeRun(id, "needlefish-review PR #42"),
			conclusion: "failure",
		})),
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /completed failed or cancelled runs; retry cap reached/);
});

test("reconcile dispatches below the completed-run cap and ignores other PRs and conclusions", () => {
	const r = runReconcile({
		completedRuns: [
			{ ...activeRun(1, "needlefish-review PR #42"), conclusion: "failure" },
			{ ...activeRun(2, "needlefish-review PR #42"), conclusion: "failure" },
			{ ...activeRun(3, "needlefish-review PR #420"), conclusion: "failure" },
			{ ...activeRun(4, "needlefish-review PR #7"), conclusion: "failure" },
			{ ...activeRun(5, "needlefish-review PR #42"), conclusion: "success" },
		],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
});

test("reconcile includes cancelled runs in the completed-run cap", () => {
	const r = runReconcile({
		completedRuns: ["failure", "cancelled", "cancelled"].map((conclusion, id) => ({
			...activeRun(id, "needlefish-review PR #42"),
			conclusion,
		})),
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /completed failed or cancelled runs; retry cap reached/);
});
