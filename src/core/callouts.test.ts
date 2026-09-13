import assert from "node:assert/strict";
import test from "node:test";
import { scopeCallouts } from "./callouts";
import type { ChangedFile, ScopeCallout } from "../shared/schema";

const CALLOUT_ORDER = [
	"dependency",
	"schema",
	"workflow",
	"config",
	"public-api",
] as const;

// A spread of inputs: empty, non-callout surfaces only, single callout
// surfaces, and a fully interleaved multi-surface set.
const INPUTS: readonly (readonly ChangedFile[])[] = [
	[],
	[
		{ path: "src/app.ts", surface: "source" },
		{ path: "docs/guide.md", surface: "docs" },
		{ path: "src/app.test.ts", surface: "test" },
	],
	[{ path: "package.json", surface: "dependency" }],
	[
		{ path: ".github/workflows/ci.yml", surface: "workflow" },
		{ path: "package.json", surface: "dependency" },
		{ path: "src/app.ts", surface: "source" },
		{ path: "pnpm-lock.yaml", surface: "dependency" },
		{ path: "db/schema.sql", surface: "schema" },
		{ path: "src/index.ts", surface: "public-api" },
		{ path: "app.config.ts", surface: "config" },
		{ path: "src/cli.ts", surface: "cli" },
	],
];

test("scopeCallouts property: every callout file is an input file with the claimed surface", () => {
	for (const changedFiles of INPUTS) {
		const byPath = new Map(changedFiles.map((f) => [f.path, f.surface]));
		const callouts = scopeCallouts(changedFiles);
		for (const callout of callouts) {
			assert.ok(callout.files.length > 0, "empty callouts must be omitted");
			for (const file of callout.files) {
				assert.equal(
					byPath.get(file),
					callout.surface,
					`${file} must be an input file whose surface is ${callout.surface}`,
				);
			}
			// Files keep input order within each callout.
			assert.deepEqual(
				callout.files,
				changedFiles
					.filter((f) => f.surface === callout.surface)
					.map((f) => f.path),
			);
		}
		// Surfaces come out in the fixed callout order, not input order.
		const ranks = callouts.map((c) => CALLOUT_ORDER.indexOf(c.surface));
		assert.deepEqual(
			ranks,
			[...ranks].sort((a, b) => a - b),
			"callout surfaces must follow the fixed order",
		);
	}
});

test("scopeCallouts emits fixed surface order and omits surfaces with no files", () => {
	const changedFiles: ChangedFile[] = [
		{ path: ".github/workflows/ci.yml", surface: "workflow" },
		{ path: "package.json", surface: "dependency" },
		{ path: "docs/guide.md", surface: "docs" },
		{ path: "src/index.ts", surface: "public-api" },
		{ path: "pnpm-lock.yaml", surface: "dependency" },
	];
	const expected: ScopeCallout[] = [
		{ surface: "dependency", files: ["package.json", "pnpm-lock.yaml"] },
		{ surface: "workflow", files: [".github/workflows/ci.yml"] },
		{ surface: "public-api", files: ["src/index.ts"] },
	];
	assert.deepEqual(scopeCallouts(changedFiles), expected);
});

test("scopeCallouts returns [] when no callout surface is present", () => {
	assert.deepEqual(
		scopeCallouts([
			{ path: "src/app.ts", surface: "source" },
			{ path: "docs/guide.md", surface: "docs" },
		]),
		[],
	);
});
