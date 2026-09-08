import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
	const scriptLines = [];
	for (const line of runBlock[1].split("\n")) {
		if (line.length > 0 && !line.startsWith("          ")) break;
		scriptLines.push(line);
	}
	return scriptLines
		.map((line) => line.replace(/^          /, ""))
		.join("\n");
}

const selectScript = workflowScript("Select self-managed Needlefish");
const reviewScript = workflowScript("Needlefish review");
const digest = value => createHash("sha256").update(value).digest("hex");

function runSelection(t, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "needlefish-self-selection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home with spaces");
  const installs = join(home, ".local/share/needlefish-self");
  const version = "0.4.3-self.test";
  const release = options.outside ? join(root, "outside", version) : join(installs, "releases", version);
  const fakeBin = join(root, "fake bin");
  const githubEnv = join(root, "env");
  const ghLog = join(root, "gh.log");
  mkdirSync(installs, { recursive: true });
  mkdirSync(fakeBin);
  writeFileSync(githubEnv, "");
  writeFileSync(ghLog, "");
  if (!options.missing) {
    mkdirSync(join(release, "bin"), { recursive: true });
    writeFileSync(join(release, "self-managed.patch"), "local tier patch");
    writeFileSync(join(release, "pnpm-lock.yaml"), "frozen lockfile");
    const metadata = {
      self_version: options.wrongVersion ? "wrong" : version,
      base_sha: "a".repeat(40),
      patch_sha256: digest("local tier patch"),
      dependency_lock_sha256: digest("frozen lockfile"),
    };
    writeFileSync(join(release, "release.json"), JSON.stringify(metadata));
    if (options.corruptPatch) writeFileSync(join(release, "self-managed.patch"), "changed");
    if (options.corruptLock) writeFileSync(join(release, "pnpm-lock.yaml"), "changed");
    if (!options.noBinary) {
      writeFileSync(join(release, "bin/needlefish"), options.brokenBinary ? "#!/bin/sh\nexit 1\n" : "#!/bin/sh\necho needlefish-self\n");
      chmodSync(join(release, "bin/needlefish"), 0o755);
    }
    symlinkSync(release, join(installs, "current"));
  }
  writeFileSync(join(fakeBin, "gh"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$GH_LOG"\n');
  chmodSync(join(fakeBin, "gh"), 0o755);
  const result = spawnSync("bash", ["-c", selectScript], {
    encoding: "utf8", timeout: 5000,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, GITHUB_ENV: githubEnv, GH_LOG: ghLog,
      REPO: "owner/repo", PR_HEAD_SHA: "b".repeat(40), EXPECTED_NEEDLEFISH_SHA: "must-not-be-used" },
  });
  return { ...result, root, release, installs, githubEnv: readFileSync(githubEnv, "utf8"), ghLog: readFileSync(ghLog, "utf8") };
}

test("selection uses operator-installed release without querying upstream or deploying", t => {
  const result = runSelection(t);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.githubEnv, `NEEDLEFISH_BIN=${result.release}/bin/needlefish\n`);
  assert.equal(result.ghLog, "");
  assert.doesNotMatch(selectScript, /commits\/main|git fetch|deploy-ubuntu|EXPECTED_NEEDLEFISH_SHA/);
});

for (const failure of ["missing", "outside", "wrongVersion", "corruptPatch", "corruptLock", "noBinary", "brokenBinary"]) {
  test(`selection fails closed and reports the exact head when ${failure}`, t => {
    const result = runSelection(t, { [failure]: true });
    assert.notEqual(result.status, 0);
    assert.equal(result.githubEnv, "");
    assert.match(result.ghLog, /repos\/owner\/repo\/check-runs/);
    assert.ok(result.ghLog.includes(`head_sha=${"b".repeat(40)}`));
    assert.match(result.ghLog, /name=Needlefish/);
    assert.match(result.ghLog, /conclusion=failure/);
  });
}

test("selection freezes the binary even if current changes afterward", t => {
  const result = runSelection(t);
  assert.equal(result.status, 0, result.stderr);
  rmSync(join(result.installs, "current"));
  symlinkSync("/unavailable/new-install", join(result.installs, "current"));
  const binary = result.githubEnv.trim().slice("NEEDLEFISH_BIN=".length);
  const run = spawnSync(binary, ["--version"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
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

test("review gives the Terra xhigh lane a production timeout", () => {
	assert.match(reviewScript, /NEEDLEFISH_TIMEOUT_MS_INPUT="1200000"/);
	assert.match(reviewScript, /export CODEX_SERVICE_TIER="fast"/);
});

test("review maps supplied Codex proxy values atomically without erasing runner defaults", (t) => {
	assert.match(workflow, /codex_proxy_base_url:\n\s+description: Optional CLIProxyAPI base URL for Codex/);
	assert.match(workflow, /codex_proxy_api_key:\n\s+description: CLIProxyAPI credential for Codex/);
	assert.match(workflow, /codex_proxy_required:\n\s+description: Prohibit Codex OAuth fallback\n\s+type: boolean/);
	assert.match(workflow, /CODEX_PROXY_BASE_URL_INPUT: \$\{\{ inputs\.codex_proxy_base_url \|\| vars\.CODEX_PROXY_BASE_URL \}\}/);
	assert.match(workflow, /CODEX_PROXY_API_KEY_INPUT: \$\{\{ secrets\.codex_proxy_api_key \}\}/);
	assert.match(workflow, /NEEDLEFISH_CODEX_PROXY_REQUIRED_INPUT: \$\{\{ inputs\.codex_proxy_required && '1' \|\| '' \}\}/);
	assert.match(reviewScript, /if \[ -n "\$CODEX_PROXY_BASE_URL_INPUT" \] \|\| \[ -n "\$CODEX_PROXY_API_KEY_INPUT" \]; then/);
	assert.match(reviewScript, /if \[ -z "\$CODEX_PROXY_BASE_URL_INPUT" \] \|\| \[ -z "\$CODEX_PROXY_API_KEY_INPUT" \]; then/);
	assert.match(reviewScript, /export CODEX_PROXY_BASE_URL="\$CODEX_PROXY_BASE_URL_INPUT"/);
	assert.match(reviewScript, /export CODEX_PROXY_API_KEY="\$CODEX_PROXY_API_KEY_INPUT"/);
	assert.match(reviewScript, /if \[ -n "\$NEEDLEFISH_CODEX_PROXY_REQUIRED_INPUT" \]; then export NEEDLEFISH_CODEX_PROXY_REQUIRED="\$NEEDLEFISH_CODEX_PROXY_REQUIRED_INPUT"; fi/);
	assert.doesNotMatch(workflow, /^\s+CODEX_PROXY_(?:BASE_URL|API_KEY):/m);
	assert.doesNotMatch(workflow, /^\s+NEEDLEFISH_CODEX_PROXY_REQUIRED:/m);

	const root = mkdtempSync(join(tmpdir(), "needlefish-workflow-proxy-pair-"));
	const binary = join(root, "needlefish");
	const invoked = join(root, "invoked");
	t.after(() => rmSync(root, { recursive: true, force: true }));
	mkdirSync(join(root, ".local", "bin"), { recursive: true });
	writeFileSync(join(root, ".local", "bin", "codex"), "#!/bin/sh\nprintf 'codex-cli 0.153.4\\n'\n");
	chmodSync(join(root, ".local", "bin", "codex"), 0o755);
	writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" > "${invoked}"\n`);
	chmodSync(binary, 0o755);
	const result = spawnSync("bash", ["-c", reviewScript], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: root,
			NEEDLEFISH_BIN: binary,
			PR_NUM: "98",
			NEEDLEFISH_RUNNER_INPUT: "codex",
			NEEDLEFISH_MODEL_INPUT: "gpt-5.6-terra",
			NEEDLEFISH_TIMEOUT_MS_INPUT: "",
			OPENCODE_IDLE_TIMEOUT_MS_INPUT: "",
			CODEX_REASONING_EFFORT: "xhigh",
			CODEX_PROXY_BASE_URL_INPUT: "https://controlled.invalid/v1",
			CODEX_PROXY_API_KEY_INPUT: "",
			CODEX_PROXY_API_KEY: "inherited-service-key",
			NEEDLEFISH_CODEX_PROXY_REQUIRED_INPUT: "",
			NEEDLEFISH_RECHECK_INPUT: "",
		},
	});
	assert.notEqual(result.status, 0);
	assert.match(result.stderr, /base URL and API key must be supplied together/);
	assert.equal(existsSync(invoked), false);

	const nonCodexResult = spawnSync("bash", ["-c", reviewScript], {
		encoding: "utf8",
		env: {
			...process.env,
			HOME: root,
			NEEDLEFISH_BIN: binary,
			PR_NUM: "98",
			NEEDLEFISH_RUNNER_INPUT: "claude",
			NEEDLEFISH_MODEL_INPUT: "claude-sonnet-4-5",
			NEEDLEFISH_TIMEOUT_MS_INPUT: "",
			OPENCODE_IDLE_TIMEOUT_MS_INPUT: "",
			CODEX_REASONING_EFFORT: "",
			CODEX_PROXY_BASE_URL_INPUT: "https://controlled.invalid/v1",
			CODEX_PROXY_API_KEY_INPUT: "",
			CODEX_PROXY_API_KEY: "inherited-service-key",
			NEEDLEFISH_CODEX_PROXY_REQUIRED_INPUT: "1",
			NEEDLEFISH_RECHECK_INPUT: "",
		},
	});
	assert.equal(nonCodexResult.status, 0, nonCodexResult.stderr);
	assert.match(readFileSync(invoked, "utf8"), /--runner claude/);
});

test("reconciliation dispatch does not depend on a local checkout", () => {
	assert.match(workflow, /cancel-in-progress: false/);
	assert.match(workflow, /WORKFLOW_REF: \$\{\{ github\.workflow_ref \}\}/);
	assert.match(workflow, /if \[ "\$head_repo" != "\$REPO" \]; then/);
	assert.match(
		workflow,
		/repos\/\$REPO\/actions\/workflows\/\$workflow_file/,
	);
	assert.match(workflow, /"HTTP 404"/);
  assert.match(workflow, /review workflow probe failed/);
  assert.match(workflow, /Needlefish: caller retry required/);
  assert.match(workflow, /conclusion="failure"/);
	assert.match(
		workflow,
		/default_branch=\$\(gh api "repos\/\$REPO" --jq \.default_branch\)/,
	);
	assert.match(
		workflow,
		/gh workflow run "\$workflow_file" --repo "\$REPO" --ref "\$default_branch" -f pr_number="\$PR_NUM"/,
	);
	assert.doesNotMatch(workflow, /gh workflow run review\.yml/);
});
