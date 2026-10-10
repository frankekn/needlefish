import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { workflowRun } from "./workflow-test-helpers.mjs";

const raw = readFileSync(".github/workflows/release.yml", "utf8");
const workflow = parse(raw);
const npmJob = workflow.jobs.npm;
const runs = npmJob.steps.map((step) => step.run ?? "").join("\n");

test("npm publish uses OIDC trusted publishing, never a stored token", () => {
	assert.deepEqual(npmJob.permissions, { contents: "read", "id-token": "write" });
	assert.match(runs, /npm publish --provenance --access public/);
	assert.doesNotMatch(readFileSync(".github/workflows/release.yml", "utf8"), /NPM_TOKEN|NODE_AUTH_TOKEN/);
});

test("npm job runs after a tag release or on dispatch for an existing tag", () => {
	assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "workflow_dispatch"]);
	assert.equal(workflow.on.workflow_dispatch.inputs.tag.required, true);
	assert.equal(workflow.jobs.release.if, "github.event_name == 'push'");
	assert.equal(npmJob.needs, "release");
	assert.match(npmJob.if, /needs\.release\.result == 'success'/);
	assert.match(npmJob.if, /workflow_dispatch' && needs\.release\.result == 'skipped'/);
	assert.equal(npmJob.env.RELEASE_TAG, "${{ inputs.tag || github.ref_name }}");
});

test("npm job refuses a tag/version mismatch and skips a version already published", () => {
	assert.match(runs, /does not match \$RELEASE_TAG/);
	assert.match(runs, /npm view "needlefish@\$version" version/);
	assert.match(runs, /publish=false/);
	const gated = npmJob.steps.filter((step) => step.name === "Publish" || step.name === "Install and smoke the packed tarball");
	assert.equal(gated.length, 2);
	for (const step of gated) assert.equal(step.if, "steps.version.outputs.publish == 'true'");
});

test("npm job requires npm 11.5+, upgrading once before failing", () => {
	const check = npmJob.steps.find((step) => step.name === "Check version").run;
	const gate = check.match(/node -e '([^']+)' "\$\(npm --version\)"/);
	assert.ok(gate, "version gate present");
	const passes = (version) =>
		new Function("process", gate[1])({ argv: ["node", version], exit: (code) => { throw code; } });
	const exitCode = (version) => { try { passes(version); } catch (code) { return code; } return undefined; };
	assert.equal(exitCode("11.4.2"), 1);
	assert.equal(exitCode("10.9.0"), 1);
	assert.equal(exitCode("11.5.1"), 0);
	assert.equal(exitCode("12.0.0"), 0);
	assert.match(check, /npm install -g npm@\^11\.5\.1/);
});

test("npm job smoke-tests the packed tarball before publishing", () => {
	const names = npmJob.steps.map((step) => step.name ?? step.uses);
	assert.ok(names.indexOf("Install and smoke the packed tarball") < names.indexOf("Publish"));
	assert.match(runs, /pnpm pack:smoke/);
});

function git(cwd, ...args) {
	const r = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
}

// Repo in the state a fetch-depth: 0 checkout leaves behind: origin/main as a
// remote-tracking ref, with one lightweight and one annotated tag on main and
// one annotated tag on a side branch that main cannot see.
function ancestryFixture() {
	const root = mkdtempSync(join(tmpdir(), "needlefish-release-ancestry-"));
	git(root, "init", "-q", "-b", "main");
	git(root, "config", "user.email", "test@example.com");
	git(root, "config", "user.name", "test");
	git(root, "config", "commit.gpgsign", "false");
	writeFileSync(join(root, "f"), "1");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "base");
	git(root, "tag", "v0.1.0");
	git(root, "tag", "-a", "v0.2.0", "-m", "release");
	git(root, "checkout", "-qb", "side");
	writeFileSync(join(root, "g"), "2");
	git(root, "add", "-A");
	git(root, "commit", "-qm", "off main");
	git(root, "tag", "-a", "v0.9.9", "-m", "off main");
	git(root, "update-ref", "refs/remotes/origin/main", git(root, "rev-parse", "main"));
	git(root, "checkout", "-q", "main");
	return root;
}

function runAncestryCheck(jobId, env, cwd) {
	const script = workflowRun(raw, jobId, "Check tag is on main");
	return spawnSync("bash", ["-eo", "pipefail", "-c", script], {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...env },
	});
}

test("release and npm jobs refuse a tag whose commit is not on main", () => {
	const root = ancestryFixture();
	try {
		for (const [jobId, envKey] of [
			["release", "GITHUB_REF_NAME"],
			["npm", "RELEASE_TAG"],
		]) {
			for (const tag of ["v0.1.0", "v0.2.0"]) {
				const ok = runAncestryCheck(jobId, { [envKey]: tag }, root);
				assert.equal(ok.status, 0, `${jobId}: ${tag} on main must pass: ${ok.stdout}${ok.stderr}`);
			}
			for (const tag of ["v0.9.9", "v9.9.9"]) {
				const bad = runAncestryCheck(jobId, { [envKey]: tag }, root);
				assert.notEqual(bad.status, 0, `${jobId}: ${tag} off main must fail`);
				assert.match(`${bad.stdout}${bad.stderr}`, /not reachable from origin\/main/);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("the ancestry check gates every mutating step and its checkout", () => {
	for (const [jobId, mutating] of [
		["release", "Roll floating major tag"],
		["npm", "Publish"],
	]) {
		const names = workflow.jobs[jobId].steps.map((step) => step.name ?? step.uses);
		const check = names.indexOf("Check tag is on main");
		assert.ok(check > -1 && check < names.indexOf(mutating), `${jobId}: ancestry check must precede ${mutating}`);
	}
	for (const jobId of ["release", "npm"]) {
		const checkout = workflow.jobs[jobId].steps.find((step) => String(step.uses ?? "").startsWith("actions/checkout"));
		assert.equal(checkout.with["fetch-depth"], 0, `${jobId}: ancestry check needs origin/main from the checkout`);
	}
});
