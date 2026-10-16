import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import positive from "../fixtures/large-tail-boundary-bug/spec";
import negative from "../fixtures/large-clean-sweep/spec";
import { loadFixture } from "../shared/fixture";
import { fixtureSetHash } from "../shared/fixture-catalog";
import { promptHash } from "../shared/prompt-hash";
import { reviewPlan } from "../../src/core/review";
import type { RunnerName } from "../../src/shared/runner";

const runner: RunnerName = "codex";

export const study = {
	id: "issue193-deep-concurrency-v2",
	status: "NOT_RUN",
	gateClass: "R",
	source: "195db3e20baddf58c4206a98d12ae29f92084e3d",
	lane: {
		runner, model: "gpt-5.6-terra", effort: "high",
		provider: "OpenAI", route: "ChatGPT", runnerVersion: "codex-cli 0.163.0",
	},
	replicatesPerFixture: 6,
	reviewConcurrency: 1,
	arms: [3, 7],
	environment: {
		NEEDLEFISH_TIMEOUT_MS: "1200000",
		NEEDLEFISH_REVIEW_TIMEOUT_MS: "1800000",
		NEEDLEFISH_RETRY_MS: "5000",
		NEEDLEFISH_NO_RETRY: "0",
		NEEDLEFISH_EVAL_TRACE: "1",
	},
	capacity: { minimumCores: 8, maximumLoadFraction: 0.5, maximumWaitMs: 1800000 },
	stopping: {
		maximumCampaignMs: 86400000,
		replacementDraws: 0,
		underfilledWorkload: {
			observeAfter: "whole-review-completed", deepCountBelow: 7,
			outcome: "WORKLOAD_UNDERFILLED", action: "stop-campaign",
			remainingSlots: "NOT_STARTED_EARLY_STOP", retainDrawAndAllAttempts: true,
		},
	},
	denominators: { plannedWholeReviewsPerArm: 12, notStartedLatency: "unavailable", equalWorkSpeedupOnUnderfill: false },
};

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtures = [positive, negative];
const typescriptConfig = /^tsconfig.*\.json$/;

export function pairedSchedule() {
	return Array.from({ length: study.replicatesPerFixture }, (_, replicate) =>
		fixtures.flatMap((fixture, fixtureIndex) => {
			const arms = (replicate + fixtureIndex) % 2 === 0 ? [3, 7] : [7, 3];
			return arms.map((deepConcurrency, position) => ({
				slot: `${fixture.id}-r${replicate + 1}-c${deepConcurrency}`,
				fixtureId: fixture.id, replicate: replicate + 1, position: position + 1,
				deepConcurrency,
			}));
		}),
	).flat();
}

export function assertDirectoryInventory(checkout: string, expected: readonly string[]): void {
	const directories = ["src", "prompts", "eval/shared"];
	const configs = readdirSync(checkout, { withFileTypes: true })
		.filter((entry) => typescriptConfig.test(entry.name))
		.map((entry) => {
			assert.equal(entry.isSymbolicLink(), false, `source symlink: ${entry.name}`);
			assert.equal(entry.isFile(), true, `source not a regular file: ${entry.name}`);
			return entry.name;
		});
	const walk = (relative: string): string[] => readdirSync(path.join(checkout, relative), { withFileTypes: true })
		.flatMap((entry) => {
			const file = `${relative}/${entry.name}`;
			assert.equal(entry.isSymbolicLink(), false, `source symlink: ${file}`);
			return entry.isDirectory() ? walk(file) : [file];
		});
	assert.deepEqual([...directories.flatMap(walk), ...configs].sort(),
		expected.filter((file) => typescriptConfig.test(file) || directories.some((directory) => file.startsWith(`${directory}/`))).sort(),
		"source path drift");
}

export function offlinePlan() {
	const configs = execFileSync("git", ["ls-tree", "--name-only", study.source], { cwd: root, encoding: "utf8" })
		.trim().split("\n").filter((file) => typescriptConfig.test(file));
	const files = execFileSync("git", ["ls-tree", "-r", "--name-only", study.source,
		"src", "prompts", "eval/shared", "eval/run.ts", "package.json", "pnpm-lock.yaml", ...configs], { cwd: root, encoding: "utf8" })
		.trim().split("\n");
	files.push(...fixtures.map((fixture) => `eval/fixtures/${fixture.id}/spec.ts`));
	assertDirectoryInventory(root, files);
	const sourceFiles = files.map((file) => {
		const committed = execFileSync("git", ["show", `${study.source}:${file}`], { cwd: root });
		assert.deepEqual(readFileSync(path.join(root, file)), committed, `source drift: ${file}`);
		return { file, sha256: createHash("sha256").update(committed).digest("hex") };
	});
	const selection = fixtures.map((fixture) => {
		assert.notEqual(fixture.holdout, true, "sealed holdouts are excluded from study design");
		const loaded = loadFixture(fixture);
		try {
			const plan = reviewPlan(loaded.bundle, { runner: study.lane.runner, model: study.lane.model });
			assert.deepEqual(plan, { docsOnlyFastPath: false, largePath: true,
				capability: { runner: "codex", capability: "repositoryRead",
					detail: "codex: repositoryRead; the CLI adapter enables repository tools." } });
			return { id: fixture.id, changedFiles: loaded.bundle.changedFiles.length,
				patchSha256: createHash("sha256").update(loaded.bundle.patch).digest("hex") };
		} finally { loaded.cleanup(); }
	});
	const protocolFiles = ["eval/tools/deep-concurrency.ts", "eval/campaigns/deep-concurrency-v2.md", "eval/campaigns/deep-concurrency-v1.md"]
		.map((file) => ({ file, sha256: createHash("sha256").update(readFileSync(path.join(root, file))).digest("hex") }));
	return { ...study, protocolFiles, modelCallsEnabled: false, fixtureSetHash: fixtureSetHash(fixtures),
		promptHash: promptHash(), sourceFiles, selection, schedule: pairedSchedule() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	assert.deepEqual(process.argv.slice(2), ["--plan"], "only --plan is supported; model execution is disabled");
	const output = JSON.stringify(offlinePlan(), null, 2) + "\n";
	assert.ok(output === readFileSync(path.join(root, "eval/campaigns/deep-concurrency-v2.plan.json"), "utf8"),
		"study plan drift: current generator requires its exact v2 comparator");
	process.stdout.write(output);
}
