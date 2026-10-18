import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { commitAll, gitText, initRepo } from "./codex-runner-test-fixtures";
import { parseReviewResult } from "./review-result";
import { normalizeFinding } from "./normalize";
import { RUNNERS, type RunStat, type RunUsage } from "./runner";
import {
	REVIEW_RESULT_SCHEMA_VERSION,
	serializeReviewResult,
	type CalloutSurface,
	type Category,
	type CoverageGap,
	type Finding,
	type ResidualRisk,
	type ReviewResult,
	type ScopeCallout,
	type Severity,
	type Verdict,
} from "./schema";

type JsonObject = { [key: string]: unknown };

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown, label: string): JsonObject {
	if (!isJsonObject(value)) throw new Error(`${label} is not an object`);
	return value;
}

const schema = asObject(
	JSON.parse(
		readFileSync(
			new URL("../../schemas/review-result.v1.schema.json", import.meta.url),
			"utf8",
		),
	),
	"schema",
);
// strict mode also rejects unknown keywords, so a schema that only looks
// like draft 2020-12 fails to compile here.
const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);

function schemaAt(...keys: readonly string[]): JsonObject {
	return keys.reduce<JsonObject>(
		(node, key) => asObject(node[key], keys.join(".")),
		schema,
	);
}

function stringList(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		throw new Error(`${label} is not a string array`);
	}
	return value;
}

function schemaEnum(...keys: readonly string[]): string[] {
	return stringList(schemaAt(...keys).enum, `${keys.join(".")}.enum`).sort();
}

function schemaErrors(value: unknown): string {
	return validate(value) ? "" : JSON.stringify(validate.errors);
}

function parses(value: unknown): boolean {
	try {
		parseReviewResult(value);
		return true;
	} catch {
		return false;
	}
}

const STUB_REVIEW = {
	summary: "One blocking bug.",
	findings: [
		{
			severity: "P1",
			title: "Doubled value breaks the consumer's bound",
			category: "bug",
			file: "src/app.ts",
			lineStart: 1,
			lineEnd: 1,
			confidence: 0.9,
			whyItBreaks: "src/use.ts:1 indexes a length-1 array with value.",
			suggestedFix: "Keep value at 1.",
			validation: "Run use() and observe undefined.",
			consumerFile: "src/use.ts",
			consumerLine: 1,
			replacement: { lines: ["export const value = 1;"] },
		},
		{
			severity: "P3",
			title: "Unused export",
			category: "contract",
			file: "src/use.ts",
			lineStart: 1,
			lineEnd: 1,
			confidence: 0.5,
			whyItBreaks: "Nothing imports use().",
			suggestedFix: "Drop the export.",
			validation: "",
		},
	],
	checked: ["EVIDENCE finding: src/app.ts:1 value doubled; src/use.ts:1 indexes by it"],
	residual_risks: [{ text: "No test covers use().", blocks: false }],
};

function makeRepo(tmp: string, files: Readonly<Record<string, string>>): string {
	const repo = initRepo(tmp);
	gitText(["branch", "-M", "main"], repo);
	gitText(["checkout", "-b", "feature"], repo);
	for (const [file, content] of Object.entries(files)) {
		mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
		writeFileSync(path.join(repo, file), content);
	}
	commitAll(repo, "feature");
	return repo;
}

function cliJson(tmp: string, repo: string, env: Readonly<Record<string, string>>, expectedExitCode: 0 | 1 = 1): unknown {
	const bin = path.join(tmp, "claude-bin.js");
	writeFileSync(
		bin,
		[
			"#!/usr/bin/env node",
			"let input = ''; process.stdin.on('data', chunk => input += chunk);",
			"process.stdin.on('end', () => {",
			`  if(input.includes('adversarial critic')) { const candidate=JSON.parse(input.slice(input.indexOf('# Candidate findings')+'# Candidate findings'.length,input.indexOf('# Diff stat'))); process.stdout.write(JSON.stringify({summary:candidate.summary,decisions:candidate.findings.map(({ref,severity,confidence})=>({ref,action:'keep',severity,confidence})),checked:candidate.checked,residual_risks:candidate.residual_risks})); } else process.stdout.write(${JSON.stringify(JSON.stringify(STUB_REVIEW))});`,
			"});",
		].join("\n"),
	);
	chmodSync(bin, 0o755);
	const result = spawnSync(
		process.execPath,
		["--import", "tsx", path.join(process.cwd(), "src/cli.ts"), "--repo", repo, "--json", "--runner", "claude"],
		{
			cwd: process.cwd(),
			encoding: "utf8",
			env: { ...process.env, CLAUDE_BIN: bin, HOME: path.join(tmp, "home"), NEEDLEFISH_NO_RETRY: "1", ...env },
		},
	);
	assert.equal(result.status, expectedExitCode, result.stderr);
	return JSON.parse(result.stdout);
}

function withTmp(t: test.TestContext): string {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-schema-test-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	return tmp;
}

const CODE_CHANGE = {
	"src/app.ts": "export const value = 2;\n",
	"src/use.ts": "import { value } from './app';\nexport const use = () => [0][value];\n",
	"package.json": '{ "name": "fixture" }\n',
};

test("--json output from a model review validates against the published schema", (t) => {
	const tmp = withTmp(t);
	const output = cliJson(tmp, makeRepo(tmp, CODE_CHANGE), { NEEDLEFISH_NO_FAST_PATH: "1" });
	const result = asObject(output, "output");

	assert.equal(schemaErrors(output), "");
	assert.ok(parses(output));
	assert.equal(result.verdict, "changes_requested");
	assert.equal(Array.isArray(result.findings) && result.findings.length, 2);
	assert.ok(Array.isArray(result.stats) && result.stats.length > 0, "stats present");
	assert.ok(Array.isArray(result.scopeCallouts) && result.scopeCallouts.length > 0, "scopeCallouts present");
});

test("--json output with eval tracing validates against the published schema", (t) => {
	const tmp = withTmp(t);
	const output = cliJson(tmp, makeRepo(tmp, CODE_CHANGE), {
		NEEDLEFISH_NO_FAST_PATH: "1",
		NEEDLEFISH_EVAL_TRACE: "1",
	});
	const result = asObject(output, "output");

	assert.equal(schemaErrors(output), "");
	assert.ok(Array.isArray(result.candidateFindings), "candidateFindings present");
	assert.ok(Array.isArray(result.rawOutputs), "rawOutputs present");
});

test("--json docs-only fast-path output validates against the published schema", (t) => {
	const tmp = withTmp(t);
	const output = cliJson(tmp, makeRepo(tmp, { "docs/guide.md": "# Guide\n" }), {}, 0);

	assert.equal(schemaErrors(output), "");
	assert.equal(asObject(output, "output").verdict, "pass");
	assert.equal(asObject(output, "output").docsOnlyFastPath, true);
});

// The schema and parseReviewResult (the reader the CLI itself uses for
// cached results) must agree on every mutation of a real output. The two
// cross-field rules JSON Schema cannot express (lineEnd >= lineStart,
// usage total >= input + output) are parser-only and not listed here.
// URL semantic validation has its own explicit schema/parser boundary test.
test("schema agrees with parseReviewResult on accepted and rejected shapes", (t) => {
	const tmp = withTmp(t);
	const real = asObject(
		cliJson(tmp, makeRepo(tmp, CODE_CHANGE), { NEEDLEFISH_NO_FAST_PATH: "1" }),
		"output",
	);

	type Mutation = (result: JsonObject, finding: JsonObject, stat: JsonObject) => void;
	const cases: readonly (readonly [string, boolean, Mutation])[] = [
		["unchanged", true, () => {}],
		["declared external premise", true, (_r, f) => { f.externalClaims = [{ claim: "Vendor syntax exists", necessary: true, source: { type: "external", url: "https://spec.example.invalid/reference" } }]; }],
		["external premise missing necessity", false, (_r, f) => { f.externalClaims = [{ claim: "Vendor syntax exists", source: { type: "external", url: "https://spec.example.invalid/reference" } }]; }],
		["source evidence", true, (_r, f) => { f.evidence = { toolRead: "unknown", sources: [{ sourceType: "git_blob", status: "source_present", revision: "a".repeat(40), file: "src/app.ts", lineStart: 1, lineEnd: 1, contentDigest: "c".repeat(64) }] }; }],
		["invented tool observation", false, (_r, f) => { f.evidence = { toolRead: "tool_observed", sources: [] }; }],
		["unverified external evidence", true, (_r, f) => { f.evidence = { toolRead: "unknown", sources: [{ sourceType: "external", status: "unverified_external_claim", claim: "Vendor syntax exists", necessary: true, source: { type: "external", url: "https://spec.example.invalid/reference" } }] }; }],
		["source present without digest", false, (_r, f) => { f.evidence = { toolRead: "unknown", sources: [{ sourceType: "git_blob", status: "source_present", revision: "a".repeat(40), file: "src/app.ts", lineStart: 1, lineEnd: 1 }] }; }],
		["source present at symbolic ref", false, (_r, f) => { f.evidence = { toolRead: "unknown", sources: [{ sourceType: "git_blob", status: "source_present", revision: "HEAD", file: "src/app.ts", lineStart: 1, lineEnd: 1, contentDigest: "c".repeat(64) }] }; }],
		["PR context fields", true, (r) => Object.assign(r, { prNumber: 7, prBaseSha: "c".repeat(40) })],
		["unknown additive field", true, (r) => { r.futureField = { any: "shape" }; }],
		["negative consumerLine", true, (_r, f) => { f.consumerLine = -3; }],
		["legacy whitespace", true, (r) => { r.summary = "  Review.  "; r.checked = ["", " checked ", "\u3000"]; }],
		["empty summary", true, (r) => { r.summary = ""; }],
		["whitespace summary", true, (r) => { r.summary = " \t\n\u3000"; }],
		["empty checked", true, (r) => { r.checked = []; }],
		["blank checked entries", true, (r) => { r.checked = ["", " \t\n\u3000"]; }],
		["wrong schemaVersion", false, (r) => { r.schemaVersion = 2; }],
		["unknown verdict", false, (r) => { r.verdict = "approve"; }],
		["missing headSha", false, (r) => { delete r.headSha; }],
		["non-string checked entry", false, (r) => { r.checked = [1]; }],
		["non-boolean residual blocks", false, (r) => { r.residualRisks = [{ text: "x", blocks: "yes" }]; }],
		["zero prNumber", false, (r) => { r.prNumber = 0; }],
		["fractional prNumber", false, (r) => { r.prNumber = 1.5; }],
		["maximum safe runtime timeouts", true, (r) => { const runtime = asObject(r.runtime, "runtime"); runtime.callTimeoutMs = Number.MAX_SAFE_INTEGER; runtime.reviewBudgetMs = Number.MAX_SAFE_INTEGER; }],
		["unsafe runtime call timeout", false, (r) => { asObject(r.runtime, "runtime").callTimeoutMs = 9007199254740992; }],
		["unsafe runtime review budget", false, (r) => { asObject(r.runtime, "runtime").reviewBudgetMs = 9007199254740992; }],
		["unknown severity", false, (_r, f) => { f.severity = "P4"; }],
		["unknown category", false, (_r, f) => { f.category = "style"; }],
		["blocking finding below 0.7 confidence", false, (_r, f) => { f.confidence = 0.5; }],
		["confidence above 1", false, (_r, f) => { f.confidence = 1.5; }],
		["zero lineStart", false, (_r, f) => { f.lineStart = 0; }],
		["empty title", false, (_r, f) => { f.title = ""; }],
		["missing validation", false, (_r, f) => { delete f.validation; }],
		["zero consumerLine", false, (_r, f) => { f.consumerLine = 0; }],
		["empty consumerFile", false, (_r, f) => { f.consumerFile = ""; }],
		["empty replacement", false, (_r, f) => { f.replacement = { lines: [] }; }],
		["single character quote", true, (_r, f) => { f.quote = "x"; }],
		["trimmed quote with inner whitespace", true, (_r, f) => { f.quote = "const x = 1;"; }],
		["quote with leading whitespace", false, (_r, f) => { f.quote = " source"; }],
		["quote with trailing whitespace", false, (_r, f) => { f.quote = "source "; }],
		["quote with surrounding whitespace", false, (_r, f) => { f.quote = " source "; }],
		["quote with Unicode edge whitespace", false, (_r, f) => { f.quote = "\u3000source\u00a0"; }],
		["quote with newline", false, (_r, f) => { f.quote = "first\nsecond"; }],
		["quote with final newline", false, (_r, f) => { f.quote = "source\n"; }],
		["quote with final carriage return", false, (_r, f) => { f.quote = "source\r"; }],
		["quote with final CRLF", false, (_r, f) => { f.quote = "source\r\n"; }],
		["quote with final Unicode line separator", false, (_r, f) => { f.quote = "source\u2028"; }],
		["quote with final Unicode paragraph separator", false, (_r, f) => { f.quote = "source\u2029"; }],
		["multi-line replacement entry", false, (_r, f) => { f.replacement = { lines: ["a\nb"] }; }],
		["unknown runner", false, (_r, _f, s) => { s.runner = "gpt"; }],
		["zero attempts", false, (_r, _f, s) => { s.attempts = 0; }],
		["negative token usage", false, (_r, _f, s) => {
			s.usage = { totalTokens: 1, inputTokens: -1, outputTokens: 0 };
		}],
		["token count above MAX_SAFE_INTEGER", false, (_r, _f, s) => {
			s.usage = { totalTokens: Number.MAX_SAFE_INTEGER + 1, inputTokens: 0, outputTokens: 0 };
		}],
		["docs skip flag", true, (r) => { r.docsOnlyFastPath = true; }],
		["invalid docs skip flag", false, (r) => { r.docsOnlyFastPath = "true"; }],
		["unknown callout surface", false, (r) => { r.scopeCallouts = [{ surface: "docs", files: ["a.md"] }]; }],
		["callout without files", false, (r) => { r.scopeCallouts = [{ surface: "config", files: [] }]; }],
		["binary paths", true, (r) => { r.unreviewedBinaryFiles = ["assets/image.bin"]; }],
		["empty binary path", false, (r) => { r.unreviewedBinaryFiles = [""]; }],
		["non-string binary path", false, (r) => { r.unreviewedBinaryFiles = [1]; }],
		["pointer-only coverage gap", true, (r) => { r.coverageGaps = [{ kind: "lfs_pointer_only", file: "assets/model.bin" }]; }],
		["incomplete-scan coverage gap", true, (r) => { r.coverageGaps = [{ kind: "lfs_scan_incomplete" }]; }],
		["unknown coverage gap kind", false, (r) => { r.coverageGaps = [{ kind: "missing_file", file: "a.bin" }]; }],
		["pointer-only coverage gap with empty file", false, (r) => { r.coverageGaps = [{ kind: "lfs_pointer_only", file: "" }]; }],
	];

	for (const [name, accepted, mutate] of cases) {
		const result = asObject(structuredClone(real), "clone");
		const findings = result.findings;
		const stats = result.stats;
		assert.ok(Array.isArray(findings) && Array.isArray(stats));
		mutate(result, asObject(findings[0], "finding"), asObject(stats[0], "stat"));
		assert.equal(parses(result), accepted, `parseReviewResult on ${name}`);
		assert.equal(validate(result), accepted, `schema on ${name}: ${JSON.stringify(validate.errors)}`);
	}
});

// Exhaustive tables: adding a field or enum member to the TypeScript types
// without a matching row fails `pnpm check`; a row the schema lacks fails
// the assertions below.
type FieldFlags<T> = { readonly [K in keyof T]-?: undefined extends T[K] ? "optional" : "required" };

function assertFields<T>(flags: FieldFlags<T>, ...schemaPath: readonly string[]): void {
	const node = schemaAt(...schemaPath);
	const label = schemaPath.join(".") || "root";
	const entries = Object.entries(flags);
	assert.deepEqual(
		Object.keys(asObject(node.properties, `${label}.properties`)).sort(),
		entries.map(([key]) => key).sort(),
		`${label} properties`,
	);
	assert.deepEqual(
		stringList(node.required, `${label}.required`).sort(),
		entries.filter(([, flag]) => flag === "required").map(([key]) => key).sort(),
		`${label} required`,
	);
}

test("schema covers every ReviewResult field with the TypeScript optionality", () => {
	assertFields<ReviewResult>({
		schemaVersion: "required",
		verdict: "required",
		summary: "required",
		findings: "required",
		checked: "required",
		residualRisks: "required",
		baseSha: "required",
		headSha: "required",
		reviewTarget: "optional",
		docsOnlyFastPath: "optional",
		prNumber: "optional",
		prBaseSha: "optional",
		scopeCallouts: "optional",
		unreviewedBinaryFiles: "optional",
		coverageGaps: "optional",
		runtime: "optional",
		stats: "optional",
		totalDurationMs: "optional",
		coverage: "optional",
		candidateFindings: "optional",
		failedRawOutputs: "optional",
		rawOutputs: "optional",
		traceDeliveryFailed: "optional",
	});
	assertFields<Finding>(
		{
			severity: "required",
			title: "required",
			category: "required",
			file: "required",
			lineStart: "required",
			lineEnd: "required",
			confidence: "required",
			whyItBreaks: "required",
			suggestedFix: "required",
			validation: "required",
			consumerFile: "optional",
			consumerLine: "optional",
			replacement: "optional",
			quote: "optional",
			quoteCheck: "optional",
			externalClaims: "optional",
			evidence: "optional",
		},
		"$defs",
		"finding",
	);
	assertFields<NonNullable<Finding["replacement"]>>(
		{ lines: "required" },
		"$defs",
		"finding",
		"properties",
		"replacement",
	);
	assertFields<{ status: NonNullable<Finding["quoteCheck"]>["status"]; from?: string }>(
		{ status: "required", from: "optional" },
		"$defs",
		"finding",
		"properties",
		"quoteCheck",
	);
	assertFields<ResidualRisk>({ text: "required", blocks: "required" }, "$defs", "residualRisk");
	assertFields<ScopeCallout>({ surface: "required", files: "required" }, "$defs", "scopeCallout");
	assertFields<Extract<CoverageGap, { kind: "lfs_pointer_only" }>>(
		{ kind: "required", file: "required" },
		"$defs",
		"lfsPointerOnlyGap",
	);
	assertFields<Extract<CoverageGap, { kind: "lfs_scan_incomplete" }>>(
		{ kind: "required" },
		"$defs",
		"lfsScanIncompleteGap",
	);
	assertFields<RunStat>(
		{
			label: "required",
			runner: "required",
			model: "optional",
			durationMs: "required",
			attempts: "required",
			ok: "required",
			usage: "optional",
		},
		"$defs",
		"runStat",
	);
	assertFields<RunUsage>(
		{ totalTokens: "required", inputTokens: "required", outputTokens: "required" },
		"$defs",
		"runUsage",
	);
	assert.equal(schemaAt("properties", "schemaVersion").const, REVIEW_RESULT_SCHEMA_VERSION);
});

test("schema enums match the runtime value sets", (t) => {
	const verdicts: Record<Verdict, true> = { pass: true, changes_requested: true, needs_human: true };
	const severities: Record<Severity, true> = { P0: true, P1: true, P2: true, P3: true };
	const categories: Record<Category, true> = {
		bug: true,
		contract: true,
		duplicate: true,
		runtime: true,
		security: true,
		validation: true,
	};
	const surfaces: Record<CalloutSurface, true> = {
		dependency: true,
		schema: true,
		workflow: true,
		config: true,
		"public-api": true,
	};
	const enums = {
		verdict: schemaEnum("properties", "verdict"),
		severity: schemaEnum("$defs", "finding", "properties", "severity"),
		category: schemaEnum("$defs", "finding", "properties", "category"),
		surface: schemaEnum("$defs", "scopeCallout", "properties", "surface"),
	};
	assert.deepEqual(enums.verdict, Object.keys(verdicts).sort());
	assert.deepEqual(enums.severity, Object.keys(severities).sort());
	assert.deepEqual(enums.category, Object.keys(categories).sort());
	assert.deepEqual(enums.surface, Object.keys(surfaces).sort());
	assert.deepEqual(schemaEnum("$defs", "runStat", "properties", "runner"), [...RUNNERS].sort());
	// coverageGap is a oneOf over one definition per kind, each pinning kind
	// with const; the union of those consts must be the runtime kind set.
	const gapKinds: Record<CoverageGap["kind"], true> = {
		lfs_pointer_only: true,
		lfs_scan_incomplete: true,
	};
	const gapKindConsts = ["lfsPointerOnlyGap", "lfsScanIncompleteGap"]
		.map((def) => schemaAt("$defs", def, "properties", "kind").const)
		.filter((value): value is string => typeof value === "string")
		.sort();
	assert.deepEqual(gapKindConsts, Object.keys(gapKinds).sort());

	const tmp = withTmp(t);
	const real = asObject(
		cliJson(tmp, makeRepo(tmp, CODE_CHANGE), { NEEDLEFISH_NO_FAST_PATH: "1" }),
		"output",
	);
	const variants: JsonObject[] = [
		...enums.verdict.map((verdict) => ({ ...real, verdict })),
		...enums.surface.map((surface) => ({ ...real, scopeCallouts: [{ surface, files: ["f"] }] })),
		{ ...real, coverageGaps: [{ kind: "lfs_pointer_only", file: "f" }, { kind: "lfs_scan_incomplete" }] },
		...RUNNERS.map((runner) => ({
			...real,
			stats: [{ label: "review", runner, durationMs: 1, attempts: 1, ok: true }],
		})),
		...enums.severity.flatMap((severity) =>
			enums.category.map((category) => ({
				...real,
				findings: [{ ...STUB_REVIEW.findings[0], severity, category }],
			})),
		),
	];
	for (const variant of variants) {
		assert.ok(parses(variant), `parseReviewResult rejects ${JSON.stringify(variant).slice(0, 200)}`);
		assert.equal(schemaErrors(variant), "");
	}
});

function externalUrlResult(url: string): ReviewResult {
	const claim = { claim: "Reference contract", necessary: true, source: { type: "external" as const, url } };
	return {
		schemaVersion: 1, verdict: "changes_requested", summary: "External premise",
		baseSha: "a".repeat(40), headSha: "b".repeat(40), checked: [], residualRisks: [],
		findings: [{ ...STUB_REVIEW.findings[0], severity: "P1", category: "bug", externalClaims: [claim],
			evidence: { toolRead: "unknown", sources: [{ ...claim, sourceType: "external", status: "unverified_external_claim" }] },
		}],
	};
}

test("public URL structure rejects malformed authority and ports without optional format validators", () => {
	for (const url of [
		"https://[::1", "https://example.com:bad/", "https://example.com:65536/",
		"https://example.com:99999/", "https://example.com:-1/", "https://:443/",
		" http://example.com ", "http://example.com:00080/", "https://example.com/\n", "https://example.com/\r\n", "https://example.com/path ",
		"https://[]/", "https://[::1]]/", "https://user:password@example.com/", "file:///tmp/spec",
	]) {
		const result = externalUrlResult(url);
		const validClaims = externalUrlResult("https://example.com/").findings[0].externalClaims;
		for (const variant of [result, { ...result, findings: [{ ...result.findings[0], externalClaims: validClaims }] }]) {
			assert.equal(validate(variant), false, url);
			assert.equal(parses(variant), false, url);
		}
	}
});

test("normalized external URLs survive serialization, the public schema, and persisted parsing", () => {
	const urls: readonly (readonly [string, string])[] = [
		["https://EXAMPLE.com", "https://example.com/"],
		["http://localhost/spec", "http://localhost/spec"],
		["https://127.0.0.1/", "https://127.0.0.1/"],
		["https://0x7f000001/", "https://127.0.0.1/"],
		["https://[::1]/", "https://[::1]/"],
		["https://[2001:0db8:0:0:0:0:0:1]:443/a", "https://[2001:db8::1]/a"],
		["https://[::ffff:192.0.2.1]/", "https://[::ffff:c000:201]/"],
		["https://例え.テスト/資料", "https://xn--r8jz45g.xn--zckzah/%E8%B3%87%E6%96%99"],
		["https://example.com:0/", "https://example.com:0/"],
		["https://example.com:65535/", "https://example.com:65535/"],
		["http://example.com:00080/", "http://example.com/"],
		["https://example.com:00444/", "https://example.com:444/"],
		["https://example.com/?a=1#section", "https://example.com/?a=1#section"],
		["https://example.com/a%2Fb?q=%40%20#%23", "https://example.com/a%2Fb?q=%40%20#%23"],
		["https://example.com/?a=\\value#\\fragment", "https://example.com/?a=\\value#\\fragment"],
	];
	for (const [input, expected] of urls) {
		const result = externalUrlResult(input);
		const normalized = normalizeFinding(result.findings[0]);
		assert.equal(normalized.externalClaims?.[0]?.source.url, expected, input);
		const claim = normalized.externalClaims?.[0];
		assert.ok(claim);
		const generated: ReviewResult = { ...result, findings: [{ ...normalized,
			evidence: { toolRead: "unknown", sources: [{ ...claim, sourceType: "external", status: "unverified_external_claim" }] },
		}] };
		const wire: unknown = JSON.parse(serializeReviewResult(generated));
		assert.equal(schemaErrors(wire), "", input);
		assert.deepEqual(parseReviewResult(wire), generated, input);
	}
});

test("public URL structure does not replace persisted WHATWG semantic validation", () => {
	const result = externalUrlResult("https://[:::]/");
	assert.equal(validate(result), true);
	assert.equal(parses(result), false);
});
