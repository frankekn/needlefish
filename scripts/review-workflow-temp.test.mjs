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

const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const configureStep = workflow.match(
	/      - name: Configure Needlefish temp storage\n([\s\S]*?)(?=\n      - name:)/,
);
assert.ok(configureStep, "Configure Needlefish temp storage step must exist");
const runBlock = configureStep[1].match(/        run: \|\n([\s\S]*)/);
assert.ok(runBlock, "Configure Needlefish temp storage must have a run block");
const script = runBlock[1]
	.split("\n")
	.map((line) => line.replace(/^          /, ""))
	.join("\n");

function runPreflight({
	spaceAvailableKib = "2097152",
	inodeTotal = "100",
	inodeFree = "10",
	dfFailure = "",
} = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-workflow-temp-"));
	const runnerTemp = join(root, "runner temp with spaces");
	const fakeBin = join(root, "fake bin");
	const githubEnv = join(root, "github-env");
	const dfLog = join(root, "df.log");
	mkdirSync(runnerTemp);
	mkdirSync(fakeBin);
	writeFileSync(
		join(fakeBin, "df"),
		`#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do printf '<%s>\\n' "$arg" >> "$DF_LOG"; done
if [[ "$DF_FAILURE" == "$1" ]]; then exit 1; fi
case "$1" in
  -Pk)
    printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'
    printf '/dev/test 4194304 0 %s 0%% %s\\n' "$DF_SPACE_AVAILABLE" "$3"
    ;;
  -Pi)
    printf 'Filesystem Inodes IUsed IFree IUse%% Mounted on\\n'
    printf '/dev/test %s 0 %s 0%% %s\\n' "$DF_INODE_TOTAL" "$DF_INODE_FREE" "$3"
    ;;
  -hT|-i)
    printf 'diagnostic %s %s\\n' "$1" "$3"
    ;;
  *) exit 64 ;;
esac
`,
	);
	chmodSync(join(fakeBin, "df"), 0o755);

	const result = spawnSync("bash", ["-c", script], {
		encoding: "utf8",
		env: {
			...process.env,
			DF_FAILURE: dfFailure,
			DF_INODE_FREE: inodeFree,
			DF_INODE_TOTAL: inodeTotal,
			DF_LOG: dfLog,
			DF_SPACE_AVAILABLE: spaceAvailableKib,
			GITHUB_ENV: githubEnv,
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			RUNNER_TEMP: runnerTemp,
		},
	});
	const output = {
		...result,
		dfLog: existsSync(dfLog) ? readFileSync(dfLog, "utf8") : "",
		githubEnv: existsSync(githubEnv) ? readFileSync(githubEnv, "utf8") : "",
		tempRoot: join(runnerTemp, "needlefish"),
	};
	rmSync(root, { recursive: true, force: true });
	return output;
}

test("temp setup runs before checkout with the existing skip guard", () => {
	const reportIndex = workflow.indexOf("      - name: Report skipped PR");
	const configureIndex = workflow.indexOf(
		"      - name: Configure Needlefish temp storage",
	);
	const checkoutIndex = workflow.indexOf(
		"      - name: Checkout review target (PR head)",
	);

	assert.ok(reportIndex < configureIndex);
	assert.ok(configureIndex < checkoutIndex);
	assert.match(
		configureStep[0],
		/^      - name: Configure Needlefish temp storage\n        if: steps\.refs\.outputs\.skip != 'true'$/m,
	);
});

test("temp setup is fail-closed and exports only after preflight", () => {
	assert.match(script, /temp_root="\$RUNNER_TEMP\/needlefish"/);
	const mkdirIndex = script.indexOf('mkdir -p "$temp_root"');
	const exportIndex = script.indexOf('>> "$GITHUB_ENV"');
	assert.notEqual(mkdirIndex, -1);
	assert.notEqual(exportIndex, -1);
	assert.ok(mkdirIndex < exportIndex);
	assert.doesNotMatch(script, /\/(?:home|mnt|tmp)(?:\/|\b)/);
	assert.doesNotMatch(script, /os\.tmpdir|TMPDIR:-|\/tmp/);
});

test("temp preflight accepts the exact capacity boundaries and preserves spaces", () => {
	const result = runPreflight();

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.githubEnv, `TMPDIR=${result.tempRoot}\n`);
	assert.match(result.dfLog, new RegExp(`<${result.tempRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}>`));
});

test("temp preflight rejects insufficient capacity with disk diagnostics", () => {
	const result = runPreflight({ spaceAvailableKib: "2097151" });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /2 GiB/);
	assert.match(result.dfLog, /<-hT>/);
	assert.match(result.dfLog, /<-i>/);
	assert.equal(result.githubEnv, "");
});

test("temp preflight rejects fewer than ten percent free inodes", () => {
	const result = runPreflight({ inodeFree: "9" });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /10%/);
	assert.match(result.dfLog, /<-hT>/);
	assert.match(result.dfLog, /<-i>/);
	assert.equal(result.githubEnv, "");
});

test("temp preflight fails closed when df cannot inspect the target", () => {
	const result = runPreflight({ dfFailure: "-Pk" });

	assert.notEqual(result.status, 0);
	assert.match(result.dfLog, /<-hT>/);
	assert.match(result.dfLog, /<-i>/);
	assert.equal(result.githubEnv, "");
});

test("temp preflight fails closed on invalid capacity data", () => {
	const result = runPreflight({ spaceAvailableKib: "unknown" });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /invalid capacity data/);
	assert.equal(result.githubEnv, "");
});

test("temp preflight fails closed on a zero inode total", () => {
	const result = runPreflight({ inodeTotal: "0" });

	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /invalid inode data/);
	assert.equal(result.githubEnv, "");
});
