import assert from "node:assert/strict";
import test from "node:test";
import {
	credentialValuesFromEnv,
	screenPayload,
	screenText,
} from "./outbound-screen.js";

const SHAPES: ReadonlyArray<readonly [string, string]> = [
	["GitHub classic token", `ghp_${"A1b2".repeat(9)}`],
	["GitHub server token", `ghs_${"Z9y8".repeat(10)}`],
	["GitHub fine-grained token", `github_pat_${"11AB_cd".repeat(8)}`],
	["OpenAI-style key", `sk-${"q7".repeat(12)}`],
	["Anthropic key", `sk-ant-${"api03-x".repeat(4)}`],
	["project key", `sk-proj-${"Pq_4".repeat(6)}`],
	["JWT", `eyJ${"hbGciOi".repeat(2)}.eyJ${"zdWIiOi".repeat(2)}.${"sig_nat-ure".repeat(2)}`],
	["AWS access key id", `AKIA${"ABCD2345".repeat(2)}`],
	["Slack token", `xoxb-${"1234-abcd".repeat(2)}`],
	[
		"PEM private key",
		`-----BEGIN RSA PRIVATE KEY-----\n${"MIIEow".repeat(8)}\n-----END RSA PRIVATE KEY-----`,
	],
];

for (const [name, secret] of SHAPES) {
	test(`screenText redacts the ${name} shape and keeps the surrounding text`, () => {
		const screened = screenText(`before ${secret} after`, []);
		assert.deepEqual(screened, {
			kind: "redacted",
			text: "before [redacted] after",
			count: 1,
		});
	});
}

test("screenText redacts a private-key block cut off before its END line", () => {
	const screened = screenText(
		`summary\n-----BEGIN PRIVATE KEY-----\n${"MIIEvg".repeat(8)}`,
		[],
	);
	assert.deepEqual(screened, {
		kind: "redacted",
		text: "summary\n[redacted]",
		count: 1,
	});
});

test("screenText redacts a lowercased credential shape", () => {
	const screened = screenText(`title akia${"abcd2345".repeat(2)} done`, []);
	assert.equal(screened.kind, "redacted");
});

test("screenPayload withholds a known value inside an escaped JSON string", () => {
	const known = 'abc123"def\\456ghi789jkl0';
	const payload = JSON.stringify({
		body: `quote "${known}"\n\\path\\ and ☃`,
		comments: [{ path: "a.ts", body: "clean" }],
	});
	assert.ok(!payload.includes(known), "the raw payload carries only the escaped form");
	assert.deepEqual(screenPayload(payload, [known]), { kind: "withheld" });
});

test("screenPayload withholds a known value in a nested array leaf", () => {
	const known = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3";
	const payload = JSON.stringify({ comments: [{ body: `x${known}y` }] });
	assert.deepEqual(screenPayload(payload, [known]), { kind: "withheld" });
});

test("screenPayload withholds a known value even when it is also credential-shaped", () => {
	const known = `ghs_${"Q1w2".repeat(10)}`;
	const payload = JSON.stringify({ body: known });
	assert.deepEqual(screenPayload(payload, [known]), { kind: "withheld" });
});

test("screenPayload redacts leaves and leaves keys and other values intact", () => {
	const token = `ghp_${"A1b2".repeat(9)}`;
	const payload = JSON.stringify({
		commit_id: "0123456789abcdef0123456789abcdef01234567",
		body: `leaked ${token}`,
		comments: [{ path: "src/a.ts", line: 3, body: token }],
		event: "COMMENT",
	});
	const screened = screenPayload(payload, []);
	assert.equal(screened.kind, "redacted");
	if (screened.kind !== "redacted") return;
	assert.equal(screened.count, 2);
	assert.deepEqual(JSON.parse(screened.text), {
		commit_id: "0123456789abcdef0123456789abcdef01234567",
		body: "leaked [redacted]",
		comments: [{ path: "src/a.ts", line: 3, body: "[redacted]" }],
		event: "COMMENT",
	});
});

test("screenPayload returns clean for a payload with no hits", () => {
	const payload = JSON.stringify({
		status: "completed",
		conclusion: "success",
		output: { title: "Needlefish: pass", summary: "risk-free sk- ghp_short" },
	});
	assert.deepEqual(screenPayload(payload, ["abc123def456ghi789jkl0"]), {
		kind: "clean",
	});
});

test("screenPayload screens non-JSON input as text", () => {
	const known = "abc123def456ghi789jkl0";
	assert.deepEqual(screenPayload(`not json ${known}`, [known]), {
		kind: "withheld",
	});
	assert.deepEqual(screenPayload(`not json xoxp-${"1234567890"}`, []), {
		kind: "redacted",
		text: "not json [redacted]",
		count: 1,
	});
});

test("credentialValuesFromEnv collects credential-named values with a letter and a digit", () => {
	const values = credentialValuesFromEnv({
		FAKE_API_KEY: "abc123def456ghi789jkl0",
		GH_TOKEN: `gho_${"k3".repeat(18)}`,
		DB_PASSWORD: "Correct-Horse-Battery-9",
		SERVICE_PRIVATEKEY: "privkeyvalue1234567890",
		CI_CREDENTIALS: "cred-0123456789-abcdefg",
		HOME: "/home/runner/abc123def456ghi789",
	});
	assert.deepEqual([...values].sort(), [
		"Correct-Horse-Battery-9",
		"abc123def456ghi789jkl0",
		"cred-0123456789-abcdefg",
		`gho_${"k3".repeat(18)}`,
		"privkeyvalue1234567890",
	].sort());
});

test("credentialValuesFromEnv skips name-list variables and weak values", () => {
	const values = credentialValuesFromEnv({
		NEEDLEFISH_SECRET_ENV_VARS: "DEEPSEEK_API_KEY2,OPENAI_API_KEY3",
		RUNNER_TOKEN_FILES: "/run/secrets/token1,/run/secrets/token2",
		OPENCODE_API_KEY_PASSTHROUGH: "ANTHROPIC_API_KEY,DEEPSEEK_API_KEY1",
		NAME_ONLY_TOKEN: "DEEPSEEK_API_KEY",
		SHORT_TOKEN: "abc123def456ghi789j",
		NO_DIGIT_SECRET: "abcdefghijklmnopqrstuvwxyz",
		NO_LETTER_SECRET: "123456789012345678901234",
		SPACED_PASSWORD: "abc123 def456 ghi789 jkl",
		EMPTY_API_KEY: "",
		UNSET_API_KEY: undefined,
	});
	assert.deepEqual(values, []);
});
