import assert from "node:assert/strict";
import fs, { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import Ajv from "ajv";
import { CRITIC_OUTPUT_SCHEMA } from "./critic-output-schema.js";
import { review } from "./review.js";
import { explainFinding } from "./explain.js";
import { runCodex } from "../shared/codex.js";
import { headSha, initRepo, isolateCodexTestHome } from "../shared/codex-runner-test-fixtures.js";
import { captureEnv, restoreEnv } from "../shared/runner-test-fixtures.js";
import type { Bundle } from "../shared/schema.js";

const validCritic = { summary: "critic summary", decisions: [], checked: ["critic coverage"], residual_risks: [] };
const validate = new Ajv({ strict: true, allErrors: true }).compile(CRITIC_OUTPUT_SCHEMA);

test("critic contract admits keep/drop and residuals and rejects malformed coverage and residual keys", () => {
	assert.equal(validate(validCritic), true);
	const keep = { ref: "f0", action: "keep", severity: "P2", confidence: 0.8 };
	assert.equal(validate({ ...validCritic, decisions: [keep, { ref: "f1", action: "drop" }], residual_risks: [{ text: "unverified caller", blocks: true }] }), true);
	for (const invalid of [
		{ ...validCritic, checked: [] },
		{ ...validCritic, checked: [" \t\n"] },
		{ ...validCritic, checked: ["coverage", " "] },
		{ ...validCritic, summary: " " },
		{ ...validCritic, residual_risks: [{ risk: "caller", blocks: false }] },
		{ ...validCritic, residual_risks: [{ text: " ", blocks: false }] },
		{ ...validCritic, residual_risks: [{ text: "caller" }] },
		{ ...validCritic, residual_risks: [{ text: "caller", blocks: false, risk: "alias" }] },
		{ ...validCritic, extra: true },
		{ ...validCritic, decisions: [{ ...keep, confidence: Infinity }] },
		{ ...validCritic, decisions: [{ ...keep, confidence: -0.1 }] },
		{ ...validCritic, decisions: [{ ...keep, confidence: 1.1 }] },
		{ ...validCritic, decisions: [{ ...keep, severity: "P4" }] },
		{ ...validCritic, decisions: [{ ref: "f0", action: "keep" }] },
		{ ...validCritic, decisions: [{ ref: "f0", action: "drop", severity: "P2" }] },
	]) assert.equal(validate(invalid), false, JSON.stringify(invalid));
});

interface Capture {
	readonly pass: string;
	readonly schemaPath: string | null;
	readonly schema: unknown;
	readonly repoPath: string;
	readonly mode: number | null;
	readonly args: readonly string[];
}

function captures(file: string): Capture[] {
	return readFileSync(file, "utf8").trim().split("\n").map(line => {
		const raw: unknown = JSON.parse(line);
		assert.ok(typeof raw === "object" && raw !== null);
		assert.ok("pass" in raw && typeof raw.pass === "string");
		assert.ok("schemaPath" in raw && (raw.schemaPath === null || typeof raw.schemaPath === "string"));
		assert.ok("schema" in raw && "repoPath" in raw && typeof raw.repoPath === "string");
		assert.ok("mode" in raw && (raw.mode === null || typeof raw.mode === "number"));
		assert.ok("args" in raw && Array.isArray(raw.args) && raw.args.every((arg: unknown) => typeof arg === "string"));
		return { pass: raw.pass, schemaPath: raw.schemaPath, schema: raw.schema, repoPath: raw.repoPath, mode: raw.mode, args: raw.args };
	});
}

function setup(t: TestContext, body = "", residuals: readonly { text: string; blocks: boolean }[] = []) {
	const root = mkdtempSync(path.join(os.tmpdir(), "needlefish-critic-schema-"));
	const repo = initRepo(root);
	const log = path.join(root, "calls.jsonl");
	const managed = path.join(root, "managed");
	const bin = path.join(root, "runner.cjs");
	const previous = captureEnv(["CODEX_BIN", "CLAUDE_BIN", "CODEX_RETRY_MS", "NEEDLEFISH_EVAL_TRACE", "NEEDLEFISH_NO_RETRY", "NEEDLEFISH_TMPDIR", "NEEDLEFISH_EPHEMERAL_HOME", "CODEX_PROXY_BASE_URL", "CODEX_PROXY_API_KEY", "NEEDLEFISH_CODEX_PROXY_REQUIRED"]);
	isolateCodexTestHome(t, root);
	t.after(() => { restoreEnv(previous); rmSync(root, { recursive: true, force: true }); });
	process.env.CODEX_BIN = bin;
	process.env.CLAUDE_BIN = bin;
	process.env.CODEX_RETRY_MS = "1";
	process.env.NEEDLEFISH_EVAL_TRACE = "1";
	process.env.NEEDLEFISH_NO_RETRY = "1";
	process.env.NEEDLEFISH_TMPDIR = managed;
	delete process.env.NEEDLEFISH_EPHEMERAL_HOME;
	delete process.env.CODEX_PROXY_BASE_URL;
	delete process.env.CODEX_PROXY_API_KEY;
	delete process.env.NEEDLEFISH_CODEX_PROXY_REQUIRED;
	writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
const codex = args.includes('--output-last-message');
const repoPath = codex ? JSON.parse(input.slice('The repository to inspect is '.length, input.indexOf('. Your startup directory'))) : process.cwd();
const pass = input.includes('adversarial critic') ? 'critic' : input.includes('review-MAP pass') ? 'map' : input.includes('doing a DEEP review') ? 'deep' : input.includes('explaining one finding') ? 'explain' : 'review';
const index = args.indexOf('--output-schema');
const schemaPath = index < 0 ? null : args[index + 1];
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pass, args, repoPath, schemaPath, schema: schemaPath ? JSON.parse(fs.readFileSync(schemaPath, 'utf8')) : null, mode: schemaPath ? fs.statSync(schemaPath).mode & 0o777 : null }) + '\\n');
${body}
let output;
if (pass === 'map') output = { summary: 'mapped', hotspots: [] };
else if (pass === 'critic') output = { ...${JSON.stringify(validCritic)}, residual_risks: ${JSON.stringify(residuals)} };
else if (pass === 'explain') output = 'explanation';
else output = { summary: 'candidate summary', findings: [], checked: ['candidate coverage'], residual_risks: ${JSON.stringify(residuals)} };
const text = typeof output === 'string' ? output : JSON.stringify(output);
if (codex) fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], text);
else process.stdout.write(text);
`);
	chmodSync(bin, 0o755);
	const bundle: Bundle = { repoPath: repo, baseSha: "base", headSha: headSha(repo), patch: "short", patchStat: " src/a.ts | 1 +", changedFiles: [{ path: "src/a.ts", surface: "source" }], agentsMd: "(none)", prMeta: null, deep: false, focus: null };
	return { root, repo, log, managed, bin, bundle };
}

function assertSchemaLifetime(log: string, expectedPasses: readonly string[]) {
	const calls = captures(log);
	assert.deepEqual(calls.map(call => call.pass), expectedPasses);
	for (const call of calls) {
		if (call.pass === "critic") {
			assert.deepEqual(call.schema, CRITIC_OUTPUT_SCHEMA);
			assert.ok(call.schemaPath && path.isAbsolute(call.schemaPath));
			assert.equal(call.schemaPath.startsWith(call.repoPath + path.sep), false);
			assert.equal(call.mode, 0o600);
			assert.equal(existsSync(call.schemaPath), false);
			assert.equal(existsSync(path.dirname(call.schemaPath)), false);
		} else {
			assert.equal(call.schemaPath, null);
			assert.equal(call.args.includes("--output-schema"), false);
		}
	}
}

for (const deep of [false, true]) {
	for (const residualOnly of [false, true]) {
		test(`Codex ${deep ? "large" : "small"} ${residualOnly ? "residual-only" : "empty bag"} review retains critic and scopes its schema`, async (t) => {
			const residuals = residualOnly ? [{ text: "caller unverified", blocks: true }] : [];
			const { bundle, log } = setup(t, "", residuals);
			const result = await review({ ...bundle, deep }, { runner: "codex" });
			assert.deepEqual(result.checked, ["critic coverage"]);
			assert.deepEqual(result.residualRisks, residuals);
			assert.equal(result.verdict, residualOnly ? "needs_human" : "pass");
			assert.equal(result.summary, deep ? "mapped — critic summary" : "critic summary");
			assertSchemaLifetime(log, deep ? ["map", "deep", "critic"] : ["review", "critic"]);
		});
	}
}

for (const bad of [
	{ name: "empty checked", value: { ...validCritic, checked: [] }, message: "malformed review output: checked list has no non-blank items" },
	{ name: "blank checked", value: { ...validCritic, checked: [" \t"] }, message: "malformed review output: checked list has no non-blank items" },
	{ name: "risk alias", value: { ...validCritic, residual_risks: [{ risk: "unverified", blocks: false }] }, message: "malformed review output: residual risk text missing" },
]) {
	test(`runner ignoring schema still rejects three ${bad.name} replies and preserves exact raws`, async (t) => {
		const raw = ` \n${JSON.stringify(bad.value)}\n `;
		const { bundle, log } = setup(t, `if (pass === 'critic') { fs.writeFileSync(args[args.indexOf('--output-last-message') + 1], ${JSON.stringify(raw)}); process.exit(0); }`);
		let failure: unknown;
		try { await review(bundle, { runner: "codex" }); } catch (error) { failure = error; }
		assert.ok(failure instanceof Error);
		assert.equal(failure.message, bad.message);
		assert.ok("rawOutputs" in failure && Array.isArray(failure.rawOutputs));
		assert.equal(failure.rawOutputs.filter((value: unknown) => value === raw).length, 6);
		assertSchemaLifetime(log, ["review", "critic", "critic", "critic"]);
	});
}

test("explain has no critic schema and Claude review receives no Codex flag", async (t) => {
	const { bundle, log } = setup(t);
	assert.equal(await explainFinding(bundle, "src/a.ts", { runner: "codex" }), "explanation");
	const result = await review(bundle, { runner: "claude" });
	assert.deepEqual(result.checked, ["critic coverage"]);
	const calls = captures(log);
	assert.deepEqual(calls.map(call => call.pass), ["explain", "review", "critic"]);
	assert.ok(calls.every(call => call.schemaPath === null && !call.args.includes("--output-schema")));
});

for (const scenario of ["nonzero", "timeout", "integrity"]) {
	test(`schema managed directory is removed after ${scenario}`, async (t) => {
		const body = scenario === "nonzero" ? "process.exit(2);" : scenario === "timeout" ? "setInterval(() => {}, 1000); return;" : "fs.writeFileSync(path.join(repoPath, 'mutation'), 'dirty');";
		const { bundle, log } = setup(t, body);
		await assert.rejects(runCodex("adversarial critic", { runner: "codex", repoPath: bundle.repoPath, targetHeadSha: bundle.headSha, codexOutputSchema: CRITIC_OUTPUT_SCHEMA, timeoutMs: scenario === "timeout" ? 500 : 2000 }), scenario === "nonzero" ? /runner exited 2/ : scenario === "timeout" ? /ETIMEDOUT/ : /modified|changed|dirty/);
		assertSchemaLifetime(log, ["critic"]);
	});
}

for (const scenario of ["write", "spawn"]) {
	test(`schema ${scenario} failure removes the managed attempt before any child invocation`, async (t) => {
		const { bundle, log, managed, bin } = setup(t);
		if (scenario === "spawn") writeFileSync(bin, "#!/definitely/missing/interpreter\n");
		const original = fs.writeFileSync;
		let schemaPath = "";
		const mocked = t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
			if (typeof args[0] === "string" && path.basename(args[0]) === "critic-output.schema.json") {
				schemaPath = args[0];
				if (scenario === "write") throw new Error("synthetic schema write failure");
			}
			return original(...args);
		});
		syncBuiltinESMExports();
		try {
			await assert.rejects(runCodex("adversarial critic", { runner: "codex", repoPath: bundle.repoPath, targetHeadSha: bundle.headSha, codexOutputSchema: CRITIC_OUTPUT_SCHEMA }), scenario === "write" ? /synthetic schema write failure/ : /ENOENT/);
		} finally {
			mocked.mock.restore();
			syncBuiltinESMExports();
		}
		assert.ok(schemaPath);
		assert.equal(existsSync(path.dirname(schemaPath)), false);
		assert.equal(existsSync(log), false);
		assert.deepEqual(readdirSync(managed, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name), []);
	});
}
