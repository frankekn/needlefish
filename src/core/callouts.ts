import type {
	CalloutSurface,
	ChangedFile,
	ScopeCallout,
} from "../shared/schema.js";

// The five pi-review human-callout classes that are decidable from paths
// alone. Auth/destructive semantics are not path-decidable — adding them
// here would be a Class R model-contract change, so they stay out.
const CALLOUT_SURFACES: readonly CalloutSurface[] = [
	"dependency",
	"schema",
	"workflow",
	"config",
	"public-api",
];

// Pure output-side diagnostic: derived from the final changedFiles list and
// attached to the ReviewResult. It is never part of the bundle or any prompt
// input, so it cannot change what the model is fed or how verdicts derive.
export function scopeCallouts(
	changedFiles: readonly ChangedFile[],
): readonly ScopeCallout[] {
	return CALLOUT_SURFACES.flatMap((surface) => {
		const files = changedFiles
			.filter((f) => f.surface === surface)
			.map((f) => f.path);
		return files.length > 0 ? [{ surface, files }] : [];
	});
}
