import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { review, reviewFailureStats } from "../src/core/review.js";
import { loadFixture } from "./shared/fixture.js";
import type { FixtureSpec } from "./shared/types.js";
import { runOne } from "./run.js";
import { isolateCodexTestHome } from "../src/shared/codex-runner-test-fixtures.js";

const spec: FixtureSpec = {
	id: "synthetic-call-accounting",
	kind: "positive",
	defectClass: "synthetic",
	description: "Synthetic accounting control",
	baseFiles: { "app.ts": "export const value = 1;\n" },
	headFiles: { "app.ts": "export const value = 2;\n" },
	expected: { verdict: "changes_requested", mustFind: [{ pattern: "Changed value", file: "app.ts" }] },
};

for (const mode of ["malformed", "format-retry", "runner-retry"] as const) {
	test(`eval draw preserves ${mode} call accounting`, async (t) => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-accounting-"));
		const previous = { ...process.env };
		t.after(() => {
			for (const name of Object.keys(process.env)) if (!(name in previous)) delete process.env[name];
			Object.assign(process.env, previous);
			rmSync(tmp, { recursive: true, force: true });
		});
		isolateCodexTestHome(t, tmp);
		mkdirSync(path.join(tmp, ".codex"));
		writeFileSync(path.join(tmp, ".codex", "auth.json"), JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_ACCOUNTING_ONLY" }), { mode: 0o600 });
		const records = path.join(tmp, "calls.jsonl");
		const bin = path.join(tmp, "codex.cjs");
		writeFileSync(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const prompt = fs.readFileSync(0, 'utf8');
const critic = prompt.includes('adversarial critic');
const records = ${JSON.stringify(records)};
const previous = fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\\n') : [];
const stage = critic ? 'critic' : 'review';
const count = previous.filter(value => value === stage).length;
fs.appendFileSync(records, stage + '\\n');
if (${JSON.stringify(mode)} === 'runner-retry' && !critic && count === 0) { process.stderr.write('temporary runner failure'); process.exit(1); }
const finding = { severity: 'P2', title: 'Changed value', category: 'bug', file: 'app.ts', lineStart: 1, lineEnd: 1, confidence: 0.9, whyItBreaks: 'Changed value breaks the caller.', suggestedFix: 'Restore the value.', validation: 'Run the caller.' };
const evidence = 'EVIDENCE finding:Changed value changed=app.ts:1 effect=broken caller';
const malformed = critic && (${JSON.stringify(mode)} === 'malformed' || (${JSON.stringify(mode)} === 'format-retry' && count === 0));
const out = { summary: stage + '-' + count, ...(critic ? { decisions: [{ref:'f0', action:'keep', severity:'P2', confidence:0.9}] } : {findings:[finding]}), checked: malformed ? [] : [evidence], residual_risks: [] };
fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message') + 1], JSON.stringify(out));
`);
		chmodSync(bin, 0o755);
		Object.assign(process.env, { CODEX_BIN: bin, CODEX_RETRY_MS: "1", NEEDLEFISH_EVAL_TRACE: "1", NEEDLEFISH_EPHEMERAL_HOME: "1" });
		delete process.env.NEEDLEFISH_NO_RETRY;
		const draw = await runOne(spec, "codex", "synthetic-model", null, false, "SYNTHETIC-CANARY");
		assert.equal(draw.score.formatOk, mode !== "malformed", draw.score.error);
		assert.equal(draw.calls, mode === "malformed" ? 4 : mode === "format-retry" ? 3 : 2, draw.score.error);
		assert.equal(draw.retries, mode === "runner-retry" ? 1 : 0);
		const rows = readFileSync(records, "utf8").trim().split("\n");
		assert.equal(rows.length, draw.calls + draw.retries);
		if (mode === "runner-retry") {
			const fixture = loadFixture(spec);
			const cause = new Error("original cause");
			const failure = new Error("progress stopped", { cause });
			try {
				await assert.rejects(review(fixture.bundle, { runner: "codex", model: "synthetic-model" }, undefined, event => {
					if (event.stage === "done") throw failure;
				}), error => {
					assert.equal(error, failure);
					assert.equal(failure.message, "progress stopped");
					assert.equal(failure.cause, cause);
					assert.equal(reviewFailureStats(error)?.length, 2, "retain calls even after result assembly");
					return true;
				});
			} finally { fixture.cleanup(); }
		}
		if (mode === "malformed") {
			const fixture = loadFixture(spec);
			try {
				await assert.rejects(review(fixture.bundle, { runner: "codex", model: "synthetic-model" }), (error) => {
					assert.ok(error instanceof Error);
					assert.match(error.message, /checked/);
					const stats = reviewFailureStats(error);
					assert.equal(stats?.length, 4);
					assert.ok(Object.isFrozen(stats));
					assert.ok(stats?.every(stat => stat.attempts === 1 && stat.ok));
					assert.ok("rawOutputs" in error && Array.isArray(error.rawOutputs));
					for (const raw of ["review-1", "critic-3", "critic-4", "critic-5"]) {
						assert.ok(error.rawOutputs.some((output: unknown) => typeof output === "string" && output.includes(raw)), raw);
					}
					assert.deepEqual(Object.keys(error).filter(key => key === "stats"), []);
					return true;
				});
			} finally { fixture.cleanup(); }
		}
	});
}

test("failure stats do not reinterpret unrelated errors or thrown values", () => {
	assert.equal(reviewFailureStats(new Error("unrelated")), undefined);
	assert.equal(reviewFailureStats("interrupted"), undefined);
	assert.equal(reviewFailureStats(null), undefined);
});
