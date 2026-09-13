import { isRunnerName, type RunStat } from "./runner.js";
import {
	REVIEW_RESULT_SCHEMA_VERSION,
	type CalloutSurface,
	type Category,
	type Finding,
	type ResidualRisk,
	type ReviewResult,
	type ScopeCallout,
	type Severity,
	type Verdict,
} from "./schema.js";

// Boundary parser for a serialized ReviewResult (e.g. last-review.json or
// --json output). Unlike normalize.ts — which coerces untrusted model output —
// this artifact was written by serializeReviewResult, so fields are validated
// strictly by type and findings keep their persisted shape byte-for-byte;
// unknown keys are ignored because additive fields are allowed within a
// schemaVersion.

type JsonRecord = Record<string, unknown>;

const LABEL = "malformed review result";

function isRecord(raw: unknown): raw is JsonRecord {
	return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

function requireRecord(raw: unknown): JsonRecord {
	if (!isRecord(raw)) throw new Error(`${LABEL}: not an object`);
	return raw;
}

function requireString(raw: JsonRecord, field: string): string {
	const value = raw[field];
	if (typeof value !== "string") {
		throw new Error(`${LABEL}: ${field} missing or not a string`);
	}
	return value;
}

function requireArray(raw: JsonRecord, field: string): readonly unknown[] {
	const value = raw[field];
	if (!Array.isArray(value)) {
		throw new Error(`${LABEL}: ${field} missing or not an array`);
	}
	return value;
}

function requireStringList(raw: JsonRecord, field: string): string[] {
	const list = requireArray(raw, field);
	if (!list.every((item) => typeof item === "string")) {
		throw new Error(`${LABEL}: ${field} contains a non-string entry`);
	}
	return list as string[];
}

function requireVerdict(raw: unknown): Verdict {
	if (raw === "pass" || raw === "changes_requested" || raw === "needs_human") {
		return raw;
	}
	throw new Error(`${LABEL}: invalid verdict ${String(raw)}`);
}

function requireResidualRisk(raw: unknown): ResidualRisk {
	const record = requireRecord(raw);
	const text = requireString(record, "text");
	const blocks = record.blocks;
	if (typeof blocks !== "boolean") {
		throw new Error(`${LABEL}: residualRisks entry blocks missing or not a boolean`);
	}
	return { text, blocks };
}

function requireSeverity(raw: unknown): Severity {
	if (raw === "P0" || raw === "P1" || raw === "P2" || raw === "P3") return raw;
	throw new Error(`severity invalid ${String(raw)}`);
}

function requireCategory(raw: unknown): Category {
	if (
		raw === "bug" ||
		raw === "contract" ||
		raw === "duplicate" ||
		raw === "runtime" ||
		raw === "security" ||
		raw === "validation"
	) {
		return raw;
	}
	throw new Error(`category invalid ${String(raw)}`);
}

function fieldString(record: JsonRecord, field: string): string {
	const value = record[field];
	if (typeof value !== "string") {
		throw new Error(`${field} missing or not a string`);
	}
	return value;
}

function fieldNonEmpty(record: JsonRecord, field: string): string {
	const value = fieldString(record, field);
	if (!value) throw new Error(`${field} is empty`);
	return value;
}

// Line numbers admit the domain normalizeFinding persists — finite numbers
// greater than zero, including fractions — so parse can never reject what
// serialize wrote.
function fieldPositiveNumber(record: JsonRecord, field: string): number {
	const value = record[field];
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
		throw new Error(`${field} missing or not a positive number`);
	}
	return value;
}

function requireReplacement(raw: unknown): Finding["replacement"] {
	if (!isRecord(raw)) throw new Error("replacement not an object");
	const lines = raw.lines;
	if (
		!Array.isArray(lines) ||
		lines.length === 0 ||
		!lines.every(
			(line): line is string =>
				typeof line === "string" &&
				!line.includes("\n") &&
				!line.includes("\r"),
		)
	) {
		throw new Error("replacement.lines missing, empty, or not newline-free strings");
	}
	return { lines };
}

function requireFinding(raw: unknown): Finding {
	if (!isRecord(raw)) throw new Error("not an object");
	const severity = requireSeverity(raw.severity);
	const category = requireCategory(raw.category);
	const file = fieldNonEmpty(raw, "file");
	const title = fieldNonEmpty(raw, "title");
	const whyItBreaks = fieldNonEmpty(raw, "whyItBreaks");
	const suggestedFix = fieldNonEmpty(raw, "suggestedFix");
	// Persisted findings always carry validation as a string; empty is legal.
	const validation = fieldString(raw, "validation");
	const lineStart = fieldPositiveNumber(raw, "lineStart");
	const lineEnd = fieldPositiveNumber(raw, "lineEnd");
	if (lineEnd < lineStart) {
		throw new Error("lineEnd before lineStart");
	}
	const confidence = raw.confidence;
	if (
		typeof confidence !== "number" ||
		!Number.isFinite(confidence) ||
		confidence < 0 ||
		confidence > 1
	) {
		throw new Error(`confidence invalid ${String(raw.confidence)}`);
	}
	// Verdict-bearing invariant: normalizeFinding only ever persists blocking
	// findings at confidence >= 0.7, so a weaker one cannot have come from a
	// real review.
	if (severity !== "P3" && confidence < 0.7) {
		throw new Error("confidence below 0.7 on a blocking severity");
	}
	const consumerFile = raw.consumerFile;
	if (consumerFile !== undefined && (typeof consumerFile !== "string" || !consumerFile)) {
		throw new Error("consumerFile not a non-empty string");
	}
	// consumerLine persists as Number(x) || undefined in normalizeFinding, so
	// the written domain is any non-zero finite number — fractional and
	// negative values are admitted to match.
	const consumerLine = raw.consumerLine;
	if (
		consumerLine !== undefined &&
		(typeof consumerLine !== "number" ||
			!Number.isFinite(consumerLine) ||
			consumerLine === 0)
	) {
		throw new Error("consumerLine not a non-zero finite number");
	}
	const replacement =
		raw.replacement === undefined ? undefined : requireReplacement(raw.replacement);
	return {
		severity,
		title,
		category,
		file,
		lineStart,
		lineEnd,
		confidence,
		whyItBreaks,
		suggestedFix,
		validation,
		...(consumerFile !== undefined ? { consumerFile } : {}),
		...(consumerLine !== undefined ? { consumerLine } : {}),
		...(replacement !== undefined ? { replacement } : {}),
	};
}

// --- Optional fields -----------------------------------------------------
// Each parser validates one optional ReviewResult field by type and throws a
// bare detail message; the caller wraps it with the field name. The mapped
// type makes the table exhaustive: adding an optional field to ReviewResult
// without a row here is a compile error.

type RequiredFieldKey =
	| "schemaVersion"
	| "verdict"
	| "summary"
	| "findings"
	| "checked"
	| "residualRisks"
	| "baseSha"
	| "headSha";

type OptionalFieldKey = Exclude<keyof ReviewResult, RequiredFieldKey>;

function stringField(value: unknown): string {
	if (typeof value !== "string") throw new Error("not a string");
	return value;
}

function finiteNumberField(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new Error("not a finite number");
	}
	return value;
}

function booleanField(value: unknown): boolean {
	if (typeof value !== "boolean") throw new Error("not a boolean");
	return value;
}

// prNumber is copied from normalizePrMeta / the GitHub PR payload, both of
// which only admit positive integers, so that is the persisted domain.
function positiveIntegerField(value: unknown): number {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		throw new Error("not a positive integer");
	}
	return value;
}

const CALLOUT_SURFACES: ReadonlySet<string> = new Set<CalloutSurface>([
	"dependency",
	"schema",
	"workflow",
	"config",
	"public-api",
]);

function isCalloutSurface(value: unknown): value is CalloutSurface {
	return typeof value === "string" && CALLOUT_SURFACES.has(value);
}

// scopeCallouts() never emits a surface with no files, so an empty files
// list is outside the persisted domain and is rejected like any other
// malformed entry.
function scopeCalloutListField(value: unknown): ScopeCallout[] {
	if (!Array.isArray(value)) throw new Error("not an array");
	return value.map((entry, index): ScopeCallout => {
		if (!isRecord(entry)) throw new Error(`entry ${index}: not an object`);
		if (!isCalloutSurface(entry.surface)) {
			throw new Error(`entry ${index}: surface invalid ${String(entry.surface)}`);
		}
		const files = entry.files;
		if (
			!Array.isArray(files) ||
			files.length === 0 ||
			!files.every((file): file is string => typeof file === "string" && file !== "")
		) {
			throw new Error(`entry ${index}: files not a non-empty array of non-empty strings`);
		}
		return { surface: entry.surface, files };
	});
}

function stringListField(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("not an array");
	if (!value.every((item): item is string => typeof item === "string")) {
		throw new Error("not an array of strings");
	}
	return value;
}

function runStatField(value: unknown): RunStat[] {
	if (!Array.isArray(value)) throw new Error("not an array");
	return value.map((entry): RunStat => {
		if (!isRecord(entry)) throw new Error("entry not an object");
		if (typeof entry.label !== "string") throw new Error("entry.label not a string");
		if (typeof entry.runner !== "string" || !isRunnerName(entry.runner)) {
			throw new Error(`entry.runner invalid: ${String(entry.runner)}`);
		}
		if (
			typeof entry.durationMs !== "number" ||
			!Number.isFinite(entry.durationMs)
		) {
			throw new Error("entry.durationMs not a finite number");
		}
		if (
			typeof entry.attempts !== "number" ||
			!Number.isInteger(entry.attempts) ||
			entry.attempts <= 0
		) {
			throw new Error("entry.attempts not a positive integer");
		}
		if (typeof entry.ok !== "boolean") throw new Error("entry.ok not a boolean");
		if (entry.model !== undefined && typeof entry.model !== "string") {
			throw new Error("entry.model not a string");
		}
		return entry.model === undefined
			? {
					label: entry.label,
					runner: entry.runner,
					durationMs: entry.durationMs,
					attempts: entry.attempts,
					ok: entry.ok,
				}
			: {
					label: entry.label,
					runner: entry.runner,
					model: entry.model,
					durationMs: entry.durationMs,
					attempts: entry.attempts,
					ok: entry.ok,
				};
	});
}

function findingListField(value: unknown): Finding[] {
	if (!Array.isArray(value)) throw new Error("not an array");
	return value.map((entry, index) => {
		try {
			return requireFinding(entry);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`entry ${index}: ${detail}`, { cause: err });
		}
	});
}

const OPTIONAL_FIELD_PARSERS: {
	readonly [K in OptionalFieldKey]-?: (value: unknown) => ReviewResult[K];
} = {
	reviewTarget: stringField,
	prNumber: positiveIntegerField,
	prBaseSha: stringField,
	scopeCallouts: scopeCalloutListField,
	stats: runStatField,
	totalDurationMs: finiteNumberField,
	coverage: stringField,
	candidateFindings: findingListField,
	failedRawOutputs: stringListField,
	rawOutputs: stringListField,
	traceDeliveryFailed: booleanField,
};

function parseField<T>(
	field: string,
	value: unknown,
	parse: (value: unknown) => T,
): T {
	try {
		return parse(value);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(`${LABEL}: ${field}: ${detail}`, { cause: err });
	}
}

export function parseReviewResult(raw: unknown): ReviewResult {
	const record = requireRecord(raw);
	if (record.schemaVersion !== REVIEW_RESULT_SCHEMA_VERSION) {
		throw new Error(
			`${LABEL}: schemaVersion must be ${REVIEW_RESULT_SCHEMA_VERSION} (got ${String(record.schemaVersion)})`,
		);
	}
	const optional: Partial<ReviewResult> = {};
	const writable = optional as Record<OptionalFieldKey, unknown>;
	for (const key of Object.keys(OPTIONAL_FIELD_PARSERS) as OptionalFieldKey[]) {
		const value = record[key];
		if (value === undefined) continue;
		writable[key] = parseField<ReviewResult[OptionalFieldKey]>(
			key,
			value,
			OPTIONAL_FIELD_PARSERS[key],
		);
	}
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		verdict: requireVerdict(record.verdict),
		summary: requireString(record, "summary"),
		findings: parseField<readonly Finding[]>(
			"findings",
			record.findings,
			findingListField,
		),
		checked: requireStringList(record, "checked"),
		residualRisks: requireArray(record, "residualRisks").map(requireResidualRisk),
		baseSha: requireString(record, "baseSha"),
		headSha: requireString(record, "headSha"),
		...optional,
	};
}
