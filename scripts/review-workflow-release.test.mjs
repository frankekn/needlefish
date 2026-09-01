import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = readFileSync(".github/workflows/review.yml", "utf8");

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

const selectScript = workflowScript("Select Needlefish release");
const reviewScript = workflowScript("Needlefish review");
const pinnedSha = "a".repeat(40);
const currentSha = "b".repeat(40);

function installRelease(
	home,
	sha,
	{
		metadataSha = sha,
		withBinary = true,
		repoUrl = "https://github.com/frankekn/needlefish.git",
	} = {},
) {
	const release = join(home, ".local", "share", "needlefish", "releases", sha);
	const bin = join(release, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(
		join(release, "release.json"),
		`${JSON.stringify({
			sha: metadataSha,
			version: "0.4.1",
			repoUrl,
			deployedAt: "2026-08-10T00:00:00Z",
			node: process.version,
		}, null, 2)}\n`,
	);
	if (withBinary) {
		writeFileSync(join(bin, "needlefish"), "#!/bin/sh\nprintf 'needlefish 0.4.1\\n'\n");
		chmodSync(join(bin, "needlefish"), 0o755);
	}
	return release;
}

function runSelection({
	expectedSha = pinnedSha,
	releases = [{ sha: pinnedSha }],
	current = currentSha,
	mainSha = pinnedSha,
	needlefishRepo = "frankekn/needlefish",
	repo = "frankekn/example",
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-workflow-release-"));
	const home = join(root, "home with spaces");
	const fakeBin = join(root, "fake bin");
	const githubEnv = join(root, "github-env");
	const ghLog = join(root, "gh.log");
	mkdirSync(home);
	mkdirSync(fakeBin);

	for (const release of releases) installRelease(home, release.sha, release);
	if (current) {
		const currentRelease = join(
			home,
			".local",
			"share",
			"needlefish",
			"releases",
			current,
		);
		if (!existsSync(currentRelease)) installRelease(home, current);
		symlinkSync(
			currentRelease,
			join(home, ".local", "share", "needlefish", "current"),
		);
	}

	writeFileSync(
		join(fakeBin, "gh"),
		`#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$GH_LOG"
if [ "\${1:-}" = api ] && [[ "\${2:-}" == repos/*/commits/main ]]; then
  printf '%s\\n' "$GH_MAIN_SHA"
fi
`,
	);
	chmodSync(join(fakeBin, "gh"), 0o755);

	const result = spawnSync("bash", ["-c", selectScript], {
		encoding: "utf8",
		env: {
			...process.env,
			EXPECTED_NEEDLEFISH_SHA: expectedSha,
			GH_LOG: ghLog,
			GH_TOKEN: "test-token",
			GITHUB_ENV: githubEnv,
			GH_MAIN_SHA: mainSha,
			HOME: home,
			NEEDLEFISH_REPO: needlefishRepo,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			PR_HEAD_SHA: "c".repeat(40),
			REPO: repo,
		},
	});
	const output = {
		...result,
		expectedBinary: join(
			home,
			".local",
			"share",
			"needlefish",
			"releases",
			expectedSha || mainSha,
			"bin",
			"needlefish",
		),
		ghLog: existsSync(ghLog) ? readFileSync(ghLog, "utf8") : "",
		githubEnv: existsSync(githubEnv) ? readFileSync(githubEnv, "utf8") : "",
	};
	rmSync(root, { recursive: true, force: true });
	return output;
}

test("selection executes the caller-pinned release even when current is newer", () => {
	const result = runSelection();

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.stdout, "needlefish 0.4.1\n");
	assert.equal(result.githubEnv, `NEEDLEFISH_BIN=${result.expectedBinary}\n`);
});

test("selection resolves an omitted pin from the requested repository main SHA", () => {
	const result = runSelection({ expectedSha: "" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.ghLog, /api repos\/frankekn\/needlefish\/commits\/main --jq \.sha/);
	assert.equal(result.githubEnv, `NEEDLEFISH_BIN=${result.expectedBinary}\n`);
});

test("selection resolves an omitted pin from the requested repository", () => {
	const result = runSelection({
		expectedSha: "",
		needlefishRepo: "example/fork",
		releases: [
			{ sha: pinnedSha, repoUrl: "https://github.com/example/fork.git" },
		],
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.ghLog, /api repos\/example\/fork\/commits\/main --jq \.sha/);
	assert.equal(result.githubEnv, `NEEDLEFISH_BIN=${result.expectedBinary}\n`);
});

test("selection fails closed and posts a check when the pinned release is absent", () => {
	const result = runSelection({ releases: [], current: currentSha });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, new RegExp(`found missing.*releases/${pinnedSha}/release\\.json`));
	assert.match(result.ghLog, /api -X POST repos\/frankekn\/example\/check-runs/);
	assert.equal(result.githubEnv, "");
});

test("selection rejects release metadata that does not match its immutable directory", () => {
	const result = runSelection({
		releases: [{ sha: pinnedSha, metadataSha: currentSha }],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, new RegExp(`expected Needlefish release ${pinnedSha}`, "i"));
	assert.match(result.stderr, new RegExp(`found ${currentSha}`));
	assert.equal(result.githubEnv, "");
});

test("selection rejects invalid SHAs before constructing a release path", () => {
	const result = runSelection({ expectedSha: "../../current", releases: [] });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /full lowercase 40-character Needlefish commit SHA/);
	assert.equal(result.githubEnv, "");
});

test("selection rejects an installed release without an executable", () => {
	const result = runSelection({
		releases: [{ sha: pinnedSha, withBinary: false }],
	});

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /missing executable/);
	assert.equal(result.githubEnv, "");
});

test("review invokes only the selected immutable release binary", () => {
	assert.match(reviewScript, /"\$NEEDLEFISH_BIN" "\$\{args\[@\]\}"/);
	assert.doesNotMatch(reviewScript, /\.local\/bin\/needlefish|needlefish\/current/);
});

test("review forwards the optional opencode idle timeout without exporting an empty value", () => {
	assert.match(workflow, /idle_timeout_ms:\n\s+description: Optional opencode inactivity timeout/);
	assert.match(
		reviewScript,
		/if \[ -n "\$OPENCODE_IDLE_TIMEOUT_MS_INPUT" \]; then export OPENCODE_IDLE_TIMEOUT_MS="\$OPENCODE_IDLE_TIMEOUT_MS_INPUT"; fi/,
	);
});

test("reconciliation dispatch does not depend on a local checkout", () => {
	assert.match(
		workflow,
		/repos\/\$REPO\/actions\/workflows\/review\.yml/,
	);
	assert.match(
		workflow,
		/gh workflow run review\.yml --repo "\$REPO" --ref main -f pr_number="\$PR_NUM"/,
	);
});
