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
import { parse } from "yaml";

// GitHub Actions interpolates ${{ }} into the run script before bash parses it.
// Double quotes do not stop command substitution: $(...) and backticks in a
// substituted value become program text and execute. That is the exploitable
// class. Passing the PR number through env: and expanding "$PR_NUM" keeps the
// value out of the script, which is the structural fix. The integer check is a
// second gate, not a reason to put ${{ }} back into the run block.

const workflow = readFileSync(".github/workflows/review.yml", "utf8");
const step = workflow.match(
	/      - name: Needlefish review\n([\s\S]*?)(?=\n      - name:|$)/,
);
assert.ok(step, "Needlefish review step must exist");
const script = workflowRun(workflow, "review", "Needlefish review");

function runReview(prNum, { runner = "", homeCodex = false, homeCodexVersion = "0.155.0", configuredCodex = false, codexBinValue, recheck = "", appId = "" } = {}) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-workflow-pr-"));
	const fakeBin = join(root, "fake bin");
	const argvLog = join(root, "argv.log");
	const codexBinLog = join(root, "codex-bin.log");
	const appIdLog = join(root, "app-id.log");
	const needlefishBin = join(fakeBin, "needlefish");
	const pathCodex = join(fakeBin, "codex");
	mkdirSync(fakeBin);
	writeFileSync(pathCodex, "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n");
	chmodSync(pathCodex, 0o755);
	const expectedHomeCodex = join(root, ".local", "bin", "codex");
	const expectedConfiguredCodex = join(root, "configured-codex");
	if (homeCodex) {
		mkdirSync(join(root, ".local", "bin"), { recursive: true });
		writeFileSync(expectedHomeCodex, `#!/bin/sh\nprintf 'codex-cli ${homeCodexVersion}\\n'\n`);
		chmodSync(expectedHomeCodex, 0o755);
	}
	if (configuredCodex) {
		writeFileSync(expectedConfiguredCodex, "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n");
		chmodSync(expectedConfiguredCodex, 0o755);
	}
	writeFileSync(
		needlefishBin,
		`#!/usr/bin/env bash
set -euo pipefail
for arg in "$@"; do printf '<%s>\\n' "$arg" >> "$ARGV_LOG"; done
printf '%s' "\${CODEX_BIN:-}" > "$CODEX_BIN_LOG"
printf '%s' "\${NEEDLEFISH_CHECK_APP_ID:-}" > "$APP_ID_LOG"
`,
	);
	chmodSync(needlefishBin, 0o755);

	const result = spawnSync("bash", ["-c", script], {
		cwd: root,
		encoding: "utf8",
		env: {
			...process.env,
			ARGV_LOG: argvLog,
			APP_ID_LOG: appIdLog,
			NEEDLEFISH_CHECK_APP_ID: parse(workflow).jobs.review.steps.find(s => s.name === "Needlefish review").env.NEEDLEFISH_CHECK_APP_ID === "" ? "" : appId,
			CODEX_BIN: codexBinValue === undefined ? (configuredCodex ? expectedConfiguredCodex : "") : codexBinValue(expectedConfiguredCodex),
			CODEX_BIN_LOG: codexBinLog,
			CODEX_REASONING_EFFORT: "",
			HOME: root,
			NEEDLEFISH_BIN: needlefishBin,
			NEEDLEFISH_MODEL_INPUT: "",
			NEEDLEFISH_RECHECK_INPUT: recheck,
			NEEDLEFISH_RUNNER_INPUT: runner,
			NEEDLEFISH_TIMEOUT_MS_INPUT: "",
			OPENCODE_IDLE_TIMEOUT_MS_INPUT: "",
			PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
			PR_NUM: prNum,
		},
	});
	const output = {
		...result,
		appId: existsSync(appIdLog) ? readFileSync(appIdLog, "utf8") : null,
		argvLog: existsSync(argvLog) ? readFileSync(argvLog, "utf8") : "",
		codexBin: existsSync(codexBinLog) ? readFileSync(codexBinLog, "utf8") : "",
		expectedHomeCodex,
		expectedConfiguredCodex,
		pwned: existsSync(join(root, "pwned")),
	};
	rmSync(root, { recursive: true, force: true });
	return output;
}

test("review resolves the PR number through env and quoted expansion", () => {
	assert.match(
		step[1],
		/PR_NUM: \$\{\{ inputs\.pr_number \|\| github\.event\.inputs\.pr_number \|\| github\.event\.pull_request\.number \}\}/,
	);
	assert.match(script, /args=\(--github --pr "\$PR_NUM"\)/);
	assert.match(script, /"\$NEEDLEFISH_BIN" "\$\{args\[@\]\}"/);
	assert.doesNotMatch(script, /\$\{\{/);
});

test("review invokes needlefish with a valid numeric PR number", () => {
	const result = runReview("42");

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.argvLog, /<--github>\n<--pr>\n<42>\n/);
});

test("review defaults Codex to the selected Terra xhigh lane", () => {
	const result = runReview("42", { runner: "codex" });

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.argvLog, /<--model>\n<gpt-5\.6-terra>\n/);
	assert.match(script, /gpt-5\.6-terra\) export CODEX_REASONING_EFFORT="xhigh"/);
});

test("review uses an installed user-local Codex CLI when CODEX_BIN is unset", () => {
	const result = runReview("42", { runner: "codex", homeCodex: true });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.codexBin, result.expectedHomeCodex);
});

test("review preserves an explicitly configured CODEX_BIN", () => {
	const result = runReview("42", {
		runner: "codex",
		homeCodex: true,
		configuredCodex: true,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.codexBin, result.expectedConfiguredCodex);
});

// The pre-flight applies runnerCommand's rule (trim, blank means unset) so a
// `needlefish doctor` verdict predicts the lane.
test("review trims a padded CODEX_BIN before probing it", () => {
	const result = runReview("42", {
		runner: "codex",
		homeCodex: true,
		configuredCodex: true,
		codexBinValue: (configured) => ` ${configured} \n`,
	});

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.codexBin, result.expectedConfiguredCodex);
});

test("review treats a whitespace-only CODEX_BIN as unset", () => {
	const result = runReview("42", { runner: "codex", homeCodex: true, codexBinValue: () => "  " });

	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.codexBin, result.expectedHomeCodex);
});

for (const whitespace of ["\u00a0", "\ufeff", "\u2000\u2028\u2029\u3000"]) {
	test(`review applies JavaScript trimming to CODEX_BIN with ${JSON.stringify(whitespace)}`, () => {
		const padded = runReview("42", {
			runner: "codex",
			configuredCodex: true,
			codexBinValue: (configured) => `${whitespace}${configured}${whitespace}`,
		});
		assert.equal(padded.status, 0, padded.stderr);
		assert.equal(padded.codexBin, padded.expectedConfiguredCodex);

		const blank = runReview("42", { runner: "codex", homeCodex: true, codexBinValue: () => whitespace });
		assert.equal(blank.status, 0, blank.stderr);
		assert.equal(blank.codexBin, blank.expectedHomeCodex);
	});
}

test("review accepts the installed Codex CLI version", () => {
	const result = runReview("42", {
		runner: "codex",
		homeCodex: true,
		homeCodexVersion: "0.155.0",
	});

	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Selected Codex CLI: codex-cli 0\.155\.0/);
	assert.match(result.argvLog, /<--runner>\n<codex>\n/);
});

test("review rejects PR number 0 before invoking needlefish", () => {
	const result = runReview("0");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects PR number -1 before invoking needlefish", () => {
	const result = runReview("-1");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects PR number abc before invoking needlefish", () => {
	const result = runReview("abc");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects a trailing-command PR number before invoking needlefish", () => {
	const result = runReview("1; touch pwned");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects an empty PR number before invoking needlefish", () => {
	const result = runReview("");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
});

test("review rejects command substitution $(touch pwned) before invoking needlefish", () => {
	const result = runReview("$(touch pwned)");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects backtick command substitution before invoking needlefish", () => {
	const result = runReview("`touch pwned`");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects command substitution appended to a numeric PR number before invoking needlefish", () => {
	const result = runReview("1$(touch pwned)");

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});

test("review rejects a quote-breaking PR number before invoking needlefish", () => {
	const result = runReview(`1" ; touch pwned ; "`);

	assert.notEqual(result.status, 0);
	assert.equal(result.argvLog, "");
	assert.equal(result.pwned, false);
});


test("automatic dispatch stays bounded and only explicit recheck adds the flag", () => {
 assert.match(step[1], /NEEDLEFISH_RECHECK_INPUT: \$\{\{ inputs\.recheck && '1' \|\| '' \}\}/);
 const automatic = runReview("42");
 assert.equal(automatic.status, 0, automatic.stderr);
 assert.doesNotMatch(automatic.argvLog, /<--recheck>/);
 const manual = runReview("42", { recheck: "1" });
 assert.equal(manual.status, 0, manual.stderr);
 assert.match(manual.argvLog, /<--recheck>/);
});


test("both dispatch entry points forward an opt-in manual recheck", () => {
 const reusable = parse(workflow);
 const hosted = parse(readFileSync(".github/workflows/hosted-review.yml", "utf8"));
 for (const trigger of ["workflow_dispatch", "workflow_call"]) {
  assert.deepEqual(reusable.on[trigger].inputs.recheck, {
   description: "Force a full review even when this head was already reviewed",
   type: "boolean", required: false, default: false,
  });
 }
 assert.equal(hosted.on.workflow_dispatch.inputs.recheck.default, false);
 assert.equal(hosted.jobs.review.with.recheck, "${{ inputs.recheck || false }}");
});

for (const appId of ["4812", "15368", "invalid", ""]) {
 test(`bundled review clears the repository or host App pin ${JSON.stringify(appId)}`, () => {
  const result = runReview("42", { appId });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.argvLog, /<--github>\n<--pr>\n<42>\n/);
  assert.equal(result.appId, "");
 });
}
