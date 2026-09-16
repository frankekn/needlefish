import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { preflightReview } from "./runner-capabilities.js";

function setEnv(t: TestContext, values: NodeJS.ProcessEnv): void {
	const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]));
	for (const [key, value] of Object.entries(values)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	t.after(() => {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	});
}

for (const runner of ["codex", "claude", "opencode", "grok", "pi"] as const) {
	test(`${runner} has adapter-provided repository tools`, () => {
		assert.deepEqual(preflightReview(false, { runner }), {
			status: "ready", requiredCapability: "repositoryRead", runner,
			capability: "repositoryRead", capabilitySource: "adapter",
		});
	});
}

test("HTTP is prompt-only regardless of the model name", () => {
	const result = preflightReview(false, { runner: "openai", model: "repo-agent-with-tools" });
	assert.equal(result.status, "unsupported");
	if (result.status !== "unsupported") throw new Error("expected unsupported");
	assert.equal(result.capability, "promptOnly");
	assert.equal(result.code, "unsupported_runner_capability");
	assert.match(result.message, /No model calls were made/);
	assert.match(result.message, /--runner codex/);
});

test("explicit runner wins over the environment without fallback", (t) => {
	setEnv(t, { NEEDLEFISH_RUNNER: "openai" });
	assert.equal(preflightReview(false, { runner: "claude" }).status, "ready");
	assert.equal(preflightReview(false).status, "unsupported");
});

test("docs policy skip needs neither a runner nor a valid ACP declaration", (t) => {
	setEnv(t, { NEEDLEFISH_RUNNER: "invalid", NEEDLEFISH_ACP_REPOSITORY_READ_SHA256: "bad" });
	assert.deepEqual(preflightReview(true), { status: "not_required", requiredCapability: "none" });
});

test("auto-detection reports missing runners without spawning anything", (t) => {
	setEnv(t, { NEEDLEFISH_RUNNER: undefined, PATH: "", CODEX_BIN: "missing", CLAUDE_BIN: "missing", OPENCODE_BIN: "missing" });
	const result = preflightReview(false);
	assert.equal(result.status, "unsupported");
	if (result.status !== "unsupported") throw new Error("expected unsupported");
	assert.equal(result.code, "runner_unavailable");
	assert.match(result.message, /No supported model runner found/);
});

test("auto-detection keeps the existing preference order and never runs the binary", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-capability-detection-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const codex = path.join(tmp, "codex");
	writeFileSync(codex, "this must not execute\n");
	chmodSync(codex, 0o755);
	setEnv(t, { NEEDLEFISH_RUNNER: undefined, PATH: "", CODEX_BIN: codex, CLAUDE_BIN: "missing", OPENCODE_BIN: "missing" });
	const result = preflightReview(false);
	assert.equal(result.status, "ready");
	if (result.status !== "ready") throw new Error("expected ready");
	assert.equal(result.runner, "codex");
});

test("ACP requires a matching operator declaration, not a name or initialize claim", (t) => {
	const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-acp-declaration-"));
	t.after(() => rmSync(tmp, { recursive: true, force: true }));
	const bin = path.join(tmp, "codex-acp");
	const marker = path.join(tmp, "executed");
	const source = `#!/bin/sh\ntouch '${marker}'\necho '{"agentCapabilities":{"repositoryRead":true}}'\n`;
	writeFileSync(bin, source);
	chmodSync(bin, 0o755);
	setEnv(t, { NEEDLEFISH_ACP_BIN: bin, NEEDLEFISH_ACP_REPOSITORY_READ_SHA256: undefined });
	assert.equal(preflightReview(false, { runner: "acp" }).status, "unsupported");
	process.env.NEEDLEFISH_ACP_REPOSITORY_READ_SHA256 = createHash("sha256").update(source).digest("hex");
	const declared = preflightReview(false, { runner: "acp" });
	assert.equal(declared.status, "ready");
	if (declared.status !== "ready") throw new Error("expected ready");
	assert.equal(declared.capabilitySource, "operator_declared");
	writeFileSync(bin, source + "# updated launcher\n");
	assert.equal(preflightReview(false, { runner: "acp" }).status, "unsupported");
	assert.equal(existsSync(marker), false, "preflight must never execute an ACP launcher");
});

for (const mode of ["relative", "missing", "directory", "bad_digest", "not_executable"] as const) {
	test(`ACP ${mode} declaration remains unknown`, (t) => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "needlefish-acp-invalid-"));
		t.after(() => rmSync(tmp, { recursive: true, force: true }));
		const bin = path.join(tmp, "launcher");
		if (mode === "directory") mkdirSync(bin);
		else if (mode !== "missing") {
			writeFileSync(bin, "launcher");
			chmodSync(bin, mode === "not_executable" ? 0o644 : 0o755);
		}
		setEnv(t, {
			NEEDLEFISH_ACP_BIN: mode === "relative" ? "launcher" : bin,
			NEEDLEFISH_ACP_REPOSITORY_READ_SHA256: mode === "bad_digest" ? "1" : createHash("sha256").update("launcher").digest("hex"),
		});
		const result = preflightReview(false, { runner: "acp" });
		assert.equal(result.status, "unsupported");
		if (result.status !== "unsupported") throw new Error("expected unsupported");
		assert.equal(result.capability, "unknown");
	});
}
