import { normalizeFinding } from "./normalize.js";
import { isRunnerName, type RunStat } from "./runner.js";
import {
	REVIEW_RESULT_SCHEMA_VERSION,
	type ResidualRisk,
	type ReviewResult,
	type Verdict,
} from "./schema.js";

// Boundary parser for a serialized ReviewResult (e.g. last-review.json or
// --json output). Unlike normalize.ts — which coerces untrusted model output —
// this artifact was written by serializeReviewResult, so fields are validated
// strictly by type; unknown keys are ignored because additive fields are
// allowed within a schemaVersion.

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

function findingListField(value: unknown) {
	if (!Array.isArray(value)) throw new Error("not an array");
	return value.map(normalizeFinding);
}

const OPTIONAL_FIELD_PARSERS: {
	readonly [K in OptionalFieldKey]-?: (value: unknown) => ReviewResult[K];
} = {
	reviewTarget: stringField,
	stats: runStatField,
	totalDurationMs: finiteNumberField,
	coverage: stringField,
	candidateFindings: findingListField,
	failedRawOutputs: stringListField,
	rawOutputs: stringListField,
	traceDeliveryFailed: booleanField,
};

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
		try {
			writable[key] = OPTIONAL_FIELD_PARSERS[key](value);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`${LABEL}: ${key}: ${detail}`, { cause: err });
		}
	}
	return {
		schemaVersion: REVIEW_RESULT_SCHEMA_VERSION,
		verdict: requireVerdict(record.verdict),
		summary: requireString(record, "summary"),
		findings: requireArray(record, "findings").map(normalizeFinding),
		checked: requireStringList(record, "checked"),
		residualRisks: requireArray(record, "residualRisks").map(requireResidualRisk),
		baseSha: requireString(record, "baseSha"),
		headSha: requireString(record, "headSha"),
		...optional,
	};
}
