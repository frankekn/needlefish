import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { FixtureSpec, HoldoutMode } from "./types";

// Catalog data only. Do not import the eval executor or model runners here.
// This file lives one level below eval/; discovery must not depend on cwd.
const EVAL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES_DIR = path.join(EVAL_DIR, "fixtures");
const FIXTURES_REAL_DIR = path.join(EVAL_DIR, "fixtures-real");

async function loadFixturesFrom(
	dirPath: string,
	glob: string | null,
): Promise<FixtureSpec[]> {
	const dirs = readdirSync(dirPath, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.filter((name) => (glob ? new RegExp(glob).test(name) : true))
		.sort();
	const specs: FixtureSpec[] = [];
	for (const dir of dirs) {
		const specPath = path.join(dirPath, dir, "spec.ts");
		if (!existsSync(specPath)) continue;
		const mod = await import(pathToFileURL(specPath).href);
		if (mod.default) specs.push(mod.default as FixtureSpec);
	}
	return specs;
}

export async function loadFixtures(
	glob: string | null,
): Promise<FixtureSpec[]> {
	const specs = await loadFixturesFrom(FIXTURES_DIR, glob);
	if (!existsSync(FIXTURES_REAL_DIR)) return specs;
	return [...specs, ...(await loadFixturesFrom(FIXTURES_REAL_DIR, glob))];
}

// Holdout filtering is a pure post-load step so plain runs always tell the
// full truth (include), prompt-tuning iteration can hide sealed holdouts
// (exclude), and final gates can run just the holdouts (only).
export function filterByHoldout(
	specs: readonly FixtureSpec[],
	mode: HoldoutMode,
): FixtureSpec[] {
	if (mode === "include") return [...specs];
	if (mode === "only") return specs.filter((s) => s.holdout === true);
	return specs.filter((s) => s.holdout !== true);
}

// Stable 16-hex digest of the fixture set actually run. Two reports are only
// comparable when both promptHash and fixtureSetHash match.
export function fixtureSetHash(specs: readonly FixtureSpec[]): string {
	const canonical = [...specs]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((s) => ({
			id: s.id,
			kind: s.kind,
			tier: s.tier ?? null,
			baseFiles: s.baseFiles,
			...(s.deletedFiles && s.deletedFiles.length > 0
				? { deletedFiles: [...s.deletedFiles].sort() }
				: {}),
			...(s.renamedFiles && s.renamedFiles.length > 0
				? {
						renamedFiles: s.renamedFiles
							.map(({ from, to }) => ({ from, to }))
							.sort(
								(a, b) =>
									a.from.localeCompare(b.from) || a.to.localeCompare(b.to),
							),
					}
				: {}),
			headFiles: s.headFiles,
			expected: s.expected,
			holdout: s.holdout ?? false,
			provenance: s.provenance,
		}));
	return createHash("sha256")
		.update(JSON.stringify(canonical))
		.digest("hex")
		.slice(0, 16);
}
