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
import { workflowRun } from "./workflow-test-helpers.mjs";

// The reconcile job is the only thing that can re-dispatch a review on its
// own, so an unbounded branch here is an unbounded model-call loop. On
// 2026-09-05 one usage-limited review produced 71 re-dispatches in 52 minutes
// because the retry cap counted check-runs through the API's default
// filter=latest (one check-run per name) and the active-run guard matched a
// workflow name this repo does not use. Each branch below runs the real
// script against a stub gh that serves canned responses per endpoint.

const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const script = workflowRun(
	workflow,
	"reconcile",
	"Re-dispatch when the latest head lacks a terminal result",
);

const REPO = "acme/widgets";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const OLD_HEAD = "f".repeat(40);
const SELF_RUN_ID = "777";

function checkRun(title, conclusion = "failure", round = {}) {
	return { name: "Needlefish", app: { id: 15368, slug: "github-actions" }, external_id: JSON.stringify({ v: 2, prNumber: 42, roundId: "fixture-round", runId: SELF_RUN_ID, ...round }), status: "completed", conclusion, output: { title } };
}

function precheck(runId, runAttempt = "1") {
	return checkRun("Needlefish: review did not start", "failure", { roundId: `precheck-${runId}-${runAttempt}`, runId, runAttempt });
}

function activeRun(id, title) {
	return { id, display_title: title };
}

// Canned responses keyed by the substring of the API path that identifies the
// endpoint. Order matters: first match wins.
function runReconcile({
	prNum = "42",
 appId = "",
	state = "open",
	headRepo = REPO,
	checkRunsAll = [],
	checkRunsLatest = null,
	oldChecks = [],
	activeRuns = {},
	reviewHead = "",
	reviewResult = "skipped",
	runAttempt = "1",
	attemptStart = "2026-11-22T08:00:00Z",
	eventHead = "",
	workflowMissing = false,
	workflowRef = `${REPO}/.github/workflows/review.yml@refs/heads/main`,
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-reconcile-"));
	const fakeBin = join(root, "fake-bin");
	const ghLog = join(root, "gh.log");
	mkdirSync(fakeBin);
	const numbered = (checks) => checks.map((check, index) => ({ id: index + 1, ...check }));
	const latest =
		checkRunsLatest ??
		// GitHub's default filter=latest: one run per check name, the newest.
		(checkRunsAll.length > 0 ? [checkRunsAll[checkRunsAll.length - 1]] : []);
	const responses = {
		pulls: JSON.stringify({ state, head: { sha: HEAD, repo: { full_name: headRepo } } }),
		checkRunsAll: JSON.stringify([{ check_runs: numbered(checkRunsAll) }]),
		oldChecks: JSON.stringify([{ check_runs: numbered(oldChecks) }]),
		checkRunsLatest: JSON.stringify({ check_runs: latest }),
		...Object.fromEntries(["queued", "pending", "waiting", "requested", "in_progress"].map(status => [
			status, JSON.stringify([{ workflow_runs: activeRuns[status] ?? [] }]),
		])),
		workflow: JSON.stringify({ id: 1, path: ".github/workflows/review.yml" }),
		attempt: JSON.stringify({ run_started_at: attemptStart }),
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
    --paginate|--slurp) shift ;;
    -X|-f) shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  *"/commits/${OLD_HEAD}/check-runs?"*) body=$(pick oldChecks) ;;
  *"/check-runs?"*"filter=all"*) body=$(pick checkRunsAll) ;;
  *"/check-runs?"*) body=$(pick checkRunsLatest) ;;
  repos/*/check-runs|repos/*/check-runs/*) body='{}' ;;
  *"/actions/workflows/"*"/runs?status="*)
    status="\${path#*status=}"
    body=$(pick "\${status%%&*}") ;;
  *"/actions/runs/"*"/attempts/"*) body=$(pick attempt) ;;
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
			NEEDLEFISH_CHECK_APP_ID: appId,
			REPO,
			RESPONSES: join(root, "responses.json"),
			RUN_ID: SELF_RUN_ID,
			GITHUB_RUN_ATTEMPT: runAttempt,
			REVIEW_HEAD: reviewHead,
			REVIEW_RESULT: reviewResult,
			EVENT_PR: eventHead ? prNum : "",
			EVENT_HEAD: eventHead,
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
	assert.match(r.log, /workflow run review.yml --repo acme\/widgets --ref main -f pr_number=42/);
	assert.doesNotMatch(r.log, /recheck=true|recheck=1/);
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

test("reconcile counts a terminated review as an infra failure", () => {
	const terminated = checkRun("Needlefish: review terminated");
	const once = runReconcile({ checkRunsAll: [terminated] });
	assert.equal(once.status, 0, once.stderr);
	assert.equal(once.dispatched, 1, once.stdout + once.stderr);
	const capped = runReconcile({ checkRunsAll: [terminated, INFRA] });
	assert.equal(capped.dispatched, 0);
	assert.match(capped.stdout, /retry cap reached/);
});

for (const title of [
	"Needlefish: changes_requested — Fix the thing",
	"Needlefish: needs_human. Review incomplete; human confirmation required",
]) {
	test(`reconcile treats ${title} as a terminal verdict`, () => {
		const r = runReconcile({ checkRunsAll: [checkRun(title, "failure")] });
		assert.equal(r.dispatched, 0);
		assert.match(r.stdout, /already has a terminal Needlefish verdict/);
	});
}

for (const status of ["queued", "pending", "waiting", "requested", "in_progress"]) {
	test(`reconcile waits for a ${status} run of the same workflow and PR`, () => {
		const r = runReconcile({ activeRuns: { [status]: [activeRun(900, "caller PR #42")] } });
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.dispatched, 0);
		assert.match(r.stdout, new RegExp(`is ${status}; letting it finish`));
	});
}

test("reconcile ignores its own run and runs for other PRs when counting active runs", () => {
	const r = runReconcile({
		checkRunsAll: [INFRA],
		activeRuns: { in_progress: [
			activeRun(Number(SELF_RUN_ID), "needlefish-review PR #42"),
			activeRun(901, "needlefish-review PR #420"),
			activeRun(902, "needlefish-review PR #7"),
		] },
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
	const fields = Object.fromEntries(
		[...posts[0].matchAll(/-f (output\[\w+\]|\w+)=(.*?)(?= -f |$)/g)]
			.map((match) => [match[1], match[2]]),
	);
	assert.deepEqual(JSON.parse(fields.external_id), {
		v: 2, prNumber: 42, roundId: "retry-required-777-1", runId: "777", runAttempt: "1",
	});
	const repeated = runReconcile({
		workflowMissing: true,
		checkRunsAll: [{
			name: fields.name,
			app: { id: 15368, slug: "github-actions" },
			status: fields.status,
			external_id: fields.external_id,
			conclusion: fields.conclusion,
			output: { title: fields["output[title]"] },
		}],
	});
	assert.equal(repeated.status, 0, repeated.stderr);
	assert.equal(repeated.dispatched, 0);
	assert.match(repeated.stdout, /already has a terminal Needlefish verdict/);
	assert.doesNotMatch(repeated.log, /api -X POST/);
});

test("reconcile rejects a PR number containing regex syntax before any API call", () => {
	const r = runReconcile({ prNum: "42|.*" });
	assert.equal(r.status, 1);
	assert.match(r.stdout, /PR number must be a positive integer/);
	assert.equal(r.dispatched, 0);
	assert.doesNotMatch(r.log, /api/);
});

test("reconcile counts failed dispatch attempts on the resolved head and stops at three", () => {
	const r = runReconcile({
		reviewHead: HEAD, reviewResult: "failure", runAttempt: "3",
		checkRunsAll: [precheck(SELF_RUN_ID), precheck(SELF_RUN_ID, "2")],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /3 failures before a review check; retry cap reached/);
	assert.ok(r.log.includes(`head_sha=${HEAD}`));
	assert.match(r.log, /precheck-777-3/);
});

test("reconcile ignores receipts owned by another PR and charges a dispatch once", () => {
	const r = runReconcile({
		reviewHead: HEAD, reviewResult: "failure",
		checkRunsAll: [precheck("100"), precheck("100"), {
			...precheck("200"), external_id: JSON.stringify({ v: 2, prNumber: 99, roundId: "precheck-200-1", runId: "200", runAttempt: "1" }),
		}],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.match(r.log, /precheck-777-1/);
});

test("reconcile charges a cancellation on the current head before review starts", () => {
	const r = runReconcile({
		eventHead: HEAD, reviewResult: "cancelled",
		checkRunsAll: [precheck("100"), precheck("200")],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.stdout, /3 failures before a review check; retry cap reached/);
});

test("reconcile leaves a cancelled pre-review attempt uncharged when another run is queued", () => {
	const r = runReconcile({
		eventHead: HEAD, reviewResult: "cancelled",
		activeRuns: { queued: [activeRun(900, "caller PR #42")] },
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.doesNotMatch(r.log, /api -X POST/);
	assert.match(r.stdout, /is queued; letting it finish/);
});

test("a rerun failure before a check is not masked by an earlier check from an old binary", () => {
	const r = runReconcile({
		reviewHead: HEAD, reviewResult: "failure", runAttempt: "2",
		checkRunsAll: [{ ...INFRA, started_at: "2026-11-22T07:59:59Z" }],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.match(r.log, /precheck-777-2/);
});

test("a check from the old binary during the current rerun prevents a duplicate charge", () => {
	const r = runReconcile({
		reviewHead: HEAD, reviewResult: "failure", runAttempt: "2",
		checkRunsAll: [{ ...INFRA, started_at: "2026-11-22T08:00:01Z" }],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.doesNotMatch(r.log, /api -X POST/);
});

test("reconcile cancels the old binary's superseded check and does not charge the new head", () => {
	const r = runReconcile({
		reviewHead: OLD_HEAD, reviewResult: "cancelled",
		oldChecks: [precheck("100"), precheck("200"), precheck("300"), checkRun("Needlefish: superseded", "neutral")],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.match(r.log, /PATCH repos\/acme\/widgets\/check-runs\/4.*conclusion=cancelled/);
	assert.doesNotMatch(r.log, /api -X POST/);
});

test("reconcile repairs a superseded check when its SHA is the head again", () => {
	const r = runReconcile({ checkRunsAll: [
		checkRun("Needlefish: pass", "success"),
		{ ...checkRun("Needlefish: superseded", "neutral"), external_id: "123456" },
	] });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.match(r.log, /PATCH repos\/acme\/widgets\/check-runs\/2.*conclusion=cancelled/);
});

test("reconcile closes a current orphan as an infra failure without creating a precheck receipt", () => {
	const r = runReconcile({
		reviewHead: HEAD, reviewResult: "cancelled",
		checkRunsAll: [INFRA, { ...checkRun("", null), status: "in_progress" }],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.log, /PATCH repos\/acme\/widgets\/check-runs\/2.*conclusion=failure/);
	assert.doesNotMatch(r.log, /precheck-777-1/);
	assert.match(r.stdout, /2 infra-failed reviews; retry cap reached/);
});

test("an infra check and workflow receipt for one attempt do not both spend retry budget", () => {
	const r = runReconcile({
		reviewHead: HEAD, reviewResult: "failure",
		checkRunsAll: [precheck("100"), precheck("200"), precheck(SELF_RUN_ID), INFRA],
	});
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 1);
	assert.doesNotMatch(r.log, /api -X POST/);
});

test("an unattributable dispatch failure is visible and leaves automatic retries stopped", () => {
	const r = runReconcile({ reviewResult: "failure" });
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.dispatched, 0);
	assert.match(r.log, /caller retry required/);
	assert.match(r.log, /did not record its target commit/);
});


for (const mode of ["foreign-app", "other-pr", "custom-pinned", "custom-mismatch", "legacy-actions"]) {
 test(`reconcile terminal identity handles ${mode}`, () => {
  const terminal = checkRun("Needlefish: pass", "success");
  if (mode.startsWith("custom") || mode === "foreign-app") terminal.app = { id: 4812, slug: "private-review-app" };
  if (mode === "other-pr") terminal.external_id = JSON.stringify({ v: 2, prNumber: 99 });
  if (mode === "legacy-actions") terminal.external_id = "123456";
  const r = runReconcile({ checkRunsAll: [terminal], appId: mode === "custom-pinned" ? "4812" : mode === "custom-mismatch" ? "9999" : "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.dispatched, mode === "legacy-actions" ? 0 : 1, r.stdout);
 });
}

test("bundled reconcile sees the Actions verdict despite a repository or host custom App pin", () => {
 const r = runReconcile({ appId: "4812", checkRunsAll: [checkRun("Needlefish: pass", "success")] });
 assert.equal(r.status, 0, r.stderr);
 assert.equal(r.dispatched, 0);
 assert.match(r.stdout, /already has a terminal Needlefish verdict/);
 assert.doesNotMatch(r.log, /api -X POST/);
});

for (const externalId of [
 JSON.stringify({ v: 2, prNumber: 42 }),
 JSON.stringify({ v: 2, prNumber: 42, roundId: "round" }),
 JSON.stringify({ v: 2, prNumber: 42, roundId: "", runId: "777" }),
 JSON.stringify({ v: 2, prNumber: 42, roundId: 5, runId: "777" }),
 JSON.stringify({ v: 2, prNumber: 42, roundId: "round", runId: 777 }),
 JSON.stringify({ v: 2, unrelated: true }),
 JSON.stringify({ v: 1, prNumber: 42 }),
 "[]", "true", "null", "unrelated", "",
]) {
 test(`reconcile rejects incomplete or unrelated receipt ${externalId}`, () => {
  const terminal = { ...checkRun("Needlefish: pass", "success"), external_id: externalId };
  const r = runReconcile({ checkRunsAll: [terminal] });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.dispatched, 1, r.stdout);
  assert.match(r.log, /workflow run review.yml .*pr_number=42/);
 });
}

test("reconcile accepts a complete v2 receipt with an empty run ID", () => {
 const terminal = { ...checkRun("Needlefish: pass", "success"), external_id: JSON.stringify({ v: 2, prNumber: 42, roundId: "round", runId: "" }) };
 const r = runReconcile({ checkRunsAll: [terminal] });
 assert.equal(r.status, 0, r.stderr);
 assert.equal(r.dispatched, 0);
 assert.match(r.stdout, /already has a terminal Needlefish verdict/);
});
