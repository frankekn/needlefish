import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflow = parse(readFileSync(".github/workflows/release.yml", "utf8"));
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
