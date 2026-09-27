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
import { parse } from "yaml";
import { workflowRun } from "./workflow-test-helpers.mjs";

// Model CLIs run unrestricted on trusted self-hosted runners, so the PR author
// (whose title and body reach the model) must be trusted before any review
// step runs. Each case executes the real step script against a stub gh.

const REPO = "acme/widgets";
const FORK = "mallory/widgets";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "89abcdef0123456789abcdef0123456789abcdef";
const SKIP_TITLE = "output[title]=Needlefish: skipped (author not trusted)";

const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const resolveScript = workflowRun(workflow, "review", "Resolve PR refs");
const reconcileScript = workflowRun(
	workflow,
	"reconcile",
	"Re-dispatch when the latest head lacks a terminal result",
);
const actionSteps = parse(readFileSync("action.yml", "utf8")).runs.steps;
const trustStep = actionSteps.find((step) => step.id === "trust");

function pull({
	association = "MEMBER",
	userType = "User",
	headRepo = REPO,
	state = "open",
} = {}) {
	return {
		state,
		author_association: association,
		user: { type: userType },
		head: { sha: HEAD, repo: { full_name: headRepo } },
		base: { sha: BASE },
	};
}

function runStep(script, env, { pr = pull(), checkRuns = [] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-author-trust-"));
	const fakeBin = join(root, "fake-bin");
	const ghLog = join(root, "gh.log");
	const output = join(root, "github-output");
	mkdirSync(fakeBin);
	writeFileSync(output, "");
	writeFileSync(join(root, "pull.json"), JSON.stringify(pr));
	writeFileSync(
		join(root, "check-runs.json"),
		JSON.stringify({ check_runs: checkRuns }),
	);
	writeFileSync(
		join(fakeBin, "gh"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "$1" = "pr" ] && [ "$2" = "view" ]; then
  jq -r '.head.sha, .base.sha, (.head.repo.full_name // ""), (.state | ascii_upcase)' "$STUB_ROOT/pull.json"
  exit 0
fi
if [ "$1" = "workflow" ] && [ "$2" = "run" ]; then exit 0; fi
if [ "$1" != "api" ]; then echo "unexpected gh $*" >&2; exit 2; fi
shift
jq_filter="."
path=""
while [ $# -gt 0 ]; do
  case "$1" in
    --jq) jq_filter="$2"; shift 2 ;;
    -X|-f) shift 2 ;;
    *) path="$1"; shift ;;
  esac
done
case "$path" in
  repos/*/check-runs) exit 0 ;;
  *"/check-runs?"*) jq -r "$jq_filter" "$STUB_ROOT/check-runs.json" ;;
  *"/pulls/"*)
    if [ -n "\${STUB_PULLS_FAIL:-}" ]; then echo "HTTP 502" >&2; exit 1; fi
    jq -r "$jq_filter" "$STUB_ROOT/pull.json" ;;
  *) echo "unexpected api path $path" >&2; exit 2 ;;
esac
`,
	);
	chmodSync(join(fakeBin, "gh"), 0o755);
	const result = spawnSync("bash", ["-eo", "pipefail", "-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			GH_LOG: ghLog,
			GH_TOKEN: "test-token",
			GITHUB_OUTPUT: output,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			REPO,
			STUB_ROOT: root,
			...env,
		},
	});
	const outputs = {};
	for (const line of readFileSync(output, "utf8").split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
	}
	const log = existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "";
	rmSync(root, { recursive: true, force: true });
	const posts = log
		.split("\n")
		.filter((line) => line.startsWith("api -X POST") && line.includes("/check-runs"));
	return { ...result, outputs, log, posts };
}

function eventEnv({ association, userType = "User", headRepo = REPO, allow = "" }) {
	return {
		PR_NUM: "42",
		EVENT_HEAD: HEAD,
		EVENT_BASE: BASE,
		EVENT_HEAD_REPO: headRepo,
		EVENT_ACTION: "synchronize",
		EVENT_AUTHOR_ASSOCIATION: association,
		EVENT_AUTHOR_TYPE: userType,
		ALLOW_UNTRUSTED_AUTHOR: allow,
	};
}

function apiEnv({ allow = "" } = {}) {
	return {
		PR_NUM: "42",
		EVENT_HEAD: "",
		EVENT_BASE: "",
		EVENT_HEAD_REPO: "",
		EVENT_ACTION: "",
		EVENT_AUTHOR_ASSOCIATION: "",
		EVENT_AUTHOR_TYPE: "",
		ALLOW_UNTRUSTED_AUTHOR: allow,
	};
}

function assertProceeds(r) {
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.outputs.skip, "false");
	assert.equal(r.outputs.head, HEAD);
	assert.deepEqual(r.posts, []);
}

function assertSkippedWithNeutralCheck(r, association) {
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.outputs.skip, "true");
	assert.match(r.outputs.skip_reason, /is not trusted/);
	assert.equal(r.posts.length, 1, r.log);
	const post = r.posts[0];
	assert.ok(post.includes(`repos/${REPO}/check-runs`), post);
	assert.ok(post.includes("name=Needlefish"), post);
	assert.ok(post.includes(`head_sha=${HEAD}`), post);
	assert.ok(post.includes("status=completed"), post);
	assert.ok(post.includes("conclusion=neutral"), post);
	assert.ok(post.includes(SKIP_TITLE), post);
	assert.ok(post.includes("allow_untrusted_author: true"), post);
	assert.ok(post.includes(`association ${association}`), post);
}

function postedCheck(post) {
	const fields = {};
	for (const match of post.matchAll(/-f (output\[\w+\]|\w+)=(.*?)(?= -f |$)/g)) {
		fields[match[1]] = match[2];
	}
	return fields;
}

test("gate runs in the first step, reading trust from env before checkout and the model run", () => {
	const steps = parse(workflow).jobs.review.steps;
	assert.equal(steps[0].name, "Resolve PR refs");
	assert.equal(
		steps[0].env.EVENT_AUTHOR_ASSOCIATION,
		"${{ github.event.pull_request.author_association }}",
	);
	assert.equal(steps[0].env.EVENT_AUTHOR_TYPE, "${{ github.event.pull_request.user.type }}");
	assert.doesNotMatch(resolveScript, /\$\{\{/);
	for (const step of steps.slice(1)) {
		if (step.name === "Report skipped PR") continue;
		assert.equal(step.if, "steps.refs.outputs.skip != 'true'", step.name);
	}
	assertSkippedWithNeutralCheck(
		runStep(resolveScript, eventEnv({ association: "NONE" })),
		"NONE",
	);
});

for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
	test(`event path: ${association} author proceeds where NONE is skipped`, () => {
		assertProceeds(runStep(resolveScript, eventEnv({ association })));
		assert.equal(runStep(resolveScript, eventEnv({ association: "NONE" })).outputs.skip, "true");
	});

	test(`api path: ${association} author proceeds where NONE is skipped`, () => {
		assertProceeds(runStep(resolveScript, apiEnv(), { pr: pull({ association }) }));
		const untrusted = runStep(resolveScript, apiEnv(), { pr: pull({ association: "NONE" }) });
		assert.equal(untrusted.outputs.skip, "true");
	});
}

for (const association of ["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "NONE"]) {
	test(`event path: ${association} author is skipped with a neutral check`, () => {
		assertSkippedWithNeutralCheck(
			runStep(resolveScript, eventEnv({ association })),
			association,
		);
	});

	test(`api path: ${association} author is skipped with a neutral check`, () => {
		const r = runStep(resolveScript, apiEnv(), { pr: pull({ association }) });
		assertSkippedWithNeutralCheck(r, association);
		assert.match(r.log, new RegExp(`api repos/${REPO}/pulls/42 --jq`));
	});
}

test("event path: a Bot author is untrusted even with MEMBER association", () => {
	assertSkippedWithNeutralCheck(
		runStep(resolveScript, eventEnv({ association: "MEMBER", userType: "Bot" })),
		"MEMBER",
	);
});

test("api path: a Bot author is untrusted even with MEMBER association", () => {
	assertSkippedWithNeutralCheck(
		runStep(resolveScript, apiEnv(), {
			pr: pull({ association: "MEMBER", userType: "Bot" }),
		}),
		"MEMBER",
	);
});

test("allow_untrusted_author, false by default on both triggers, is the only way an untrusted author proceeds", () => {
	const on = parse(workflow).on;
	for (const trigger of ["workflow_dispatch", "workflow_call"]) {
		const input = on[trigger].inputs.allow_untrusted_author;
		assert.equal(input?.type, "boolean", trigger);
		assert.equal(input.default, false, trigger);
	}
	const resolve = parse(workflow).jobs.review.steps[0];
	assert.equal(
		resolve.env.ALLOW_UNTRUSTED_AUTHOR,
		"${{ inputs.allow_untrusted_author && '1' || '' }}",
	);

	const bot = eventEnv({ association: "NONE", userType: "Bot" });
	assert.equal(runStep(resolveScript, bot).outputs.skip, "true");
	assertProceeds(runStep(resolveScript, { ...bot, ALLOW_UNTRUSTED_AUTHOR: "1" }));

	const newcomer = { pr: pull({ association: "FIRST_TIME_CONTRIBUTOR" }) };
	assert.equal(runStep(resolveScript, apiEnv(), newcomer).outputs.skip, "true");
	assertProceeds(runStep(resolveScript, apiEnv({ allow: "1" }), newcomer));
});

test("fork skip wins over the author skip and posts no check", () => {
	const sameRepo = runStep(resolveScript, eventEnv({ association: "NONE" }));
	assert.equal(sameRepo.posts.length, 1, sameRepo.log);

	const event = runStep(resolveScript, eventEnv({ association: "NONE", headRepo: FORK }));
	assert.equal(event.outputs.skip, "true");
	assert.match(event.outputs.skip_reason, /differs from/);
	assert.deepEqual(event.posts, []);

	const api = runStep(resolveScript, apiEnv(), {
		pr: pull({ association: "NONE", headRepo: FORK }),
	});
	assert.equal(api.outputs.skip, "true");
	assert.match(api.outputs.skip_reason, /differs from/);
	assert.deepEqual(api.posts, []);
});

test("closed PR skip wins over the author skip and posts no check", () => {
	const open = runStep(resolveScript, apiEnv(), { pr: pull({ association: "NONE" }) });
	assert.equal(open.posts.length, 1, open.log);

	const r = runStep(resolveScript, apiEnv(), {
		pr: pull({ association: "NONE", state: "closed" }),
	});
	assert.equal(r.outputs.skip, "true");
	assert.match(r.outputs.skip_reason, /PR state is CLOSED/);
	assert.deepEqual(r.posts, []);
});

test("reconcile treats the posted skip check as terminal and never dispatches the override", () => {
	for (const file of [
		".github/workflows/review.yml",
		".github/workflows/hosted-review.yml",
		".github/workflows/commands.yml",
	]) {
		for (const dispatch of readFileSync(file, "utf8").match(/gh workflow run [^\n]*/g) ?? []) {
			assert.doesNotMatch(dispatch, /allow_untrusted_author/, file);
		}
	}
	assert.doesNotMatch(reconcileScript, /allow_untrusted_author/);
	assert.equal(
		parse(readFileSync(".github/workflows/hosted-review.yml", "utf8")).jobs.review.with
			.allow_untrusted_author,
		undefined,
	);

	const skipped = runStep(resolveScript, eventEnv({ association: "NONE" }));
	assert.equal(skipped.posts.length, 1, skipped.log);
	const posted = postedCheck(skipped.posts[0]);
	const r = runStep(
		reconcileScript,
		{
			PR_NUM: "42",
			WORKFLOW_REF: `${REPO}/.github/workflows/review.yml@refs/heads/main`,
			RUN_ID: "777",
		},
		{
			pr: pull({ association: "NONE" }),
			checkRuns: [
				{ conclusion: posted.conclusion, output: { title: posted["output[title]"] } },
			],
		},
	);
	assert.equal(r.status, 0, r.stderr);
	assert.match(r.stdout, /already has a terminal Needlefish verdict/);
	assert.doesNotMatch(r.log, /^workflow run/m);
});

function actionEnv({ association, userType = "User", allow = "false", eventHead = HEAD }) {
	return {
		PR_INPUT: "",
		EVENT_PR: "42",
		EVENT_HEAD: eventHead,
		EVENT_AUTHOR_ASSOCIATION: eventHead ? association : "",
		EVENT_AUTHOR_TYPE: eventHead ? userType : "",
		ALLOW_UNTRUSTED_AUTHOR: allow,
	};
}

test("action: the first step skips untrusted and bot authors with a neutral check and gates every later step", () => {
	assert.equal(actionSteps[0], trustStep);
	assert.doesNotMatch(trustStep.run, /\$\{\{/);
	for (const step of actionSteps.slice(1)) {
		assert.equal(step.if, "steps.trust.outputs.skip != 'true'", step.name ?? step.uses);
	}
	for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
		const r = runStep(trustStep.run, actionEnv({ association }));
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.outputs.skip, undefined, association);
		assert.deepEqual(r.posts, []);
	}
	for (const [association, userType] of [
		["CONTRIBUTOR", "User"],
		["FIRST_TIME_CONTRIBUTOR", "User"],
		["NONE", "User"],
		["MEMBER", "Bot"],
	]) {
		const r = runStep(trustStep.run, actionEnv({ association, userType }));
		assert.equal(r.status, 0, r.stderr);
		assert.equal(r.outputs.skip, "true", association);
		assert.equal(r.posts.length, 1, r.log);
		assert.ok(r.posts[0].includes("conclusion=neutral"), r.posts[0]);
		assert.ok(r.posts[0].includes(SKIP_TITLE), r.posts[0]);
	}
});

test("action: api path classifies the same way and the override proceeds", () => {
	const untrusted = runStep(trustStep.run, actionEnv({ eventHead: "" }), {
		pr: pull({ association: "NONE" }),
	});
	assert.equal(untrusted.outputs.skip, "true");
	assert.ok(untrusted.posts[0]?.includes(`head_sha=${HEAD}`), untrusted.log);

	const trusted = runStep(trustStep.run, actionEnv({ eventHead: "" }), {
		pr: pull({ association: "COLLABORATOR" }),
	});
	assert.equal(trusted.outputs.skip, undefined);

	const allowed = runStep(trustStep.run, actionEnv({ association: "NONE", allow: "true" }));
	assert.equal(allowed.outputs.skip, undefined);
	assert.deepEqual(allowed.posts, []);
});

test("an unreadable author fails the review step instead of skipping as untrusted", () => {
	const failed = runStep(resolveScript, { ...apiEnv(), STUB_PULLS_FAIL: "1" });
	assert.notEqual(failed.status, 0);
	assert.notEqual(failed.outputs.skip, "true");
	assert.deepEqual(failed.posts, []);
	const blank = runStep(resolveScript, apiEnv(), { pr: { ...pull(), author_association: null, user: null } });
	assert.notEqual(blank.status, 0);
	assert.deepEqual(blank.posts, []);
});

test("an unreadable PR fails action.yml instead of skipping green", () => {
	const failed = runStep(trustStep.run, { ...actionEnv({ eventHead: "" }), STUB_PULLS_FAIL: "1" });
	assert.notEqual(failed.status, 0);
	assert.notEqual(failed.outputs.skip, "true");
	assert.deepEqual(failed.posts, []);
});
