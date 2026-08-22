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

const workflow = readFileSync(".github/workflows/commands.yml", "utf8");

function workflowScript(stepName) {
	const escapedName = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const step = workflow.match(
		new RegExp(`      - name: ${escapedName}\\n([\\s\\S]*?)(?=\\n      - name:|$)`),
	);
	assert.ok(step, `${stepName} step must exist`);
	const runBlock = step[1].match(/        run: \|\n([\s\S]*)/);
	assert.ok(runBlock, `${stepName} must have a run block`);
	return runBlock[1]
		.split("\n")
		.map((line) => line.replace(/^          /, ""))
		.join("\n");
}

const script = workflowScript("Check repository permission");

const ROLE_TO_PERMISSION = {
	admin: "admin",
	maintain: "write",
	write: "write",
	triage: "read",
	read: "read",
	none: "none",
};

function lastOutput(text, key) {
	let value = "";
	for (const line of text.split("\n")) {
		if (line.startsWith(`${key}=`)) value = line.slice(key.length + 1);
	}
	return value;
}

function runGate({
	payload,
	apiFailure = false,
	commenter = "alice",
	repo = "acme/widgets",
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-commands-auth-"));
	const fakeBin = join(root, "fake-bin");
	const githubOutput = join(root, "github-output");
	const ghLog = join(root, "gh.log");
	mkdirSync(fakeBin);
	writeFileSync(githubOutput, "");
	writeFileSync(
		join(fakeBin, "gh"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "\${GH_API_FAIL:-}" = "1" ]; then
  echo "gh api failed" >&2
  exit 1
fi
printf '%s\\n' "\$GH_PAYLOAD"
`,
	);
	chmodSync(join(fakeBin, "gh"), 0o755);

	const result = spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			COMMENTER: commenter,
			GH_API_FAIL: apiFailure ? "1" : "",
			GH_LOG: ghLog,
			GH_PAYLOAD: payload ?? "",
			GH_TOKEN: "test-token",
			GITHUB_OUTPUT: githubOutput,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			REPO: repo,
		},
	});
	const output = {
		...result,
		ghLog: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "",
		githubOutput: existsSync(githubOutput)
			? readFileSync(githubOutput, "utf8")
			: "",
	};
	rmSync(root, { recursive: true, force: true });
	return output;
}

function payloadFor(role, permission = ROLE_TO_PERMISSION[role]) {
	const body = { permission };
	if (role !== undefined) body.role_name = role;
	return JSON.stringify(body);
}

test("cheap prefilter requires a PR comment with the command prefix", () => {
	const parseJob = workflow.match(/\n  parse:\n([\s\S]*?)\n  explain:/);
	assert.ok(parseJob, "parse job must exist");
	assert.match(parseJob[1], /github\.event\.issue\.pull_request/);
	assert.match(
		parseJob[1],
		/startsWith\(github\.event\.comment\.body, '@needlefish '\)/,
	);
	assert.doesNotMatch(parseJob[1], /author_association/);
});

test("permission lookup is on ubuntu-latest before any side effect or self-hosted work", () => {
	const parseIndex = workflow.indexOf("\n  parse:");
	const explainIndex = workflow.indexOf("\n  explain:");
	const authIndex = workflow.indexOf(
		"      - name: Check repository permission",
	);
	const parseStepIndex = workflow.indexOf("      - name: Parse command");
	const ackIndex = workflow.indexOf("      - name: Acknowledge");
	const dispatchIndex = workflow.indexOf("      - name: Dispatch recheck");
	const selfHostedIndex = workflow.indexOf("runs-on: self-hosted");

	assert.ok(parseIndex !== -1 && parseIndex < authIndex);
	assert.ok(authIndex < parseStepIndex);
	assert.ok(parseStepIndex < ackIndex);
	assert.ok(ackIndex < dispatchIndex);
	assert.ok(dispatchIndex < explainIndex);
	assert.ok(selfHostedIndex > explainIndex);
	assert.match(
		workflow.slice(parseIndex, explainIndex),
		/runs-on: ubuntu-latest/,
	);
	assert.doesNotMatch(
		workflow.slice(parseIndex, explainIndex),
		/self-hosted/,
	);
});

test("acknowledgement and dispatch require the permission gate", () => {
	assert.match(
		workflow,
		/      - name: Parse command\n        if: steps\.auth\.outputs\.allowed == 'true'$/m,
	);
	assert.match(
		workflow,
		/      - name: Acknowledge\n        if: steps\.auth\.outputs\.allowed == 'true' && steps\.cmd\.outputs\.command != ''$/m,
	);
	assert.match(
		workflow,
		/      - name: Dispatch recheck\n        if: steps\.auth\.outputs\.allowed == 'true' && steps\.cmd\.outputs\.command == 'recheck'$/m,
	);
});

test("command parsing is unchanged", () => {
	const parseScript = workflowScript("Parse command");
	assert.match(parseScript, /first_line="\$\{BODY%%\$'\\n'\*\}"/);
	assert.match(parseScript, /"@needlefish recheck"\)/);
	assert.match(parseScript, /"@needlefish explain "\*\)/);
	assert.match(parseScript, /finding="\$\{first_line#@needlefish explain \}"/);
});

test("workflow permissions are not widened", () => {
	assert.match(
		workflow,
		/^permissions:\n  contents: read\n  pull-requests: write\n  actions: write\n/m,
	);
	assert.doesNotMatch(workflow, /administration:|members:|contents: write/);
});

test("gate script does not use association and only looks up collaborator permission", () => {
	assert.doesNotMatch(script, /author_association|OWNER|MEMBER|COLLABORATOR/);
	assert.match(
		script,
		/gh api "repos\/\$\{REPO\}\/collaborators\/\$\{COMMENTER\}\/permission"/,
	);
	assert.doesNotMatch(script, /reactions|workflow run|-X POST/);
});

for (const role of ["admin", "maintain", "write"]) {
	test(`${role} is authorized`, () => {
		const result = runGate({ payload: payloadFor(role) });

		assert.equal(result.status, 0, result.stderr);
		assert.equal(lastOutput(result.githubOutput, "allowed"), "true");
		assert.match(
			result.ghLog,
			/api repos\/acme\/widgets\/collaborators\/alice\/permission/,
		);
		assert.doesNotMatch(result.ghLog, /POST|reactions|workflow run/);
	});
}

for (const role of ["triage", "read", "none"]) {
	test(`${role} is denied`, () => {
		const result = runGate({ payload: payloadFor(role) });

		assert.notEqual(result.status, 0);
		assert.notEqual(lastOutput(result.githubOutput, "allowed"), "true");
		assert.match(result.stderr, /Denied: commenter lacks write permission/);
		assert.match(
			result.ghLog,
			/api repos\/acme\/widgets\/collaborators\/alice\/permission/,
		);
		assert.doesNotMatch(result.ghLog, /POST|reactions|workflow run/);
	});
}

test("legacy payload without role_name allows write and denies read", () => {
	const allowed = runGate({
		payload: JSON.stringify({ permission: "write" }),
	});
	assert.equal(allowed.status, 0, allowed.stderr);
	assert.equal(lastOutput(allowed.githubOutput, "allowed"), "true");

	const denied = runGate({
		payload: JSON.stringify({ permission: "read" }),
	});
	assert.notEqual(denied.status, 0);
	assert.notEqual(lastOutput(denied.githubOutput, "allowed"), "true");
});

test("API lookup failure is denied fail-closed", () => {
	const result = runGate({
		payload: payloadFor("admin"),
		apiFailure: true,
	});

	assert.notEqual(result.status, 0);
	assert.notEqual(lastOutput(result.githubOutput, "allowed"), "true");
	assert.match(result.stderr, /Failed to look up repository permission/);
});

test("malformed permission payload is denied fail-closed", () => {
	const result = runGate({ payload: "not-json" });

	assert.notEqual(result.status, 0);
	assert.notEqual(lastOutput(result.githubOutput, "allowed"), "true");
	assert.match(result.stderr, /Invalid permission payload/);
});
