import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// Line/regex scanner, not a YAML parser: Node has no YAML built-in and this
// repo's workflow tests stay dependency-free. Each `uses: actions/checkout`
// step must set persist-credentials: false, or be on the allowlist below
// with a YAML comment documenting why persisted git auth is required.

// A new actions/checkout is a new place the job token can land on disk. The
// coverage guard keeps a checkout from vanishing from the scan; this keeps one
// from appearing without anyone deciding it should.
const EXPECTED_CHECKOUT_COUNT = 6;

const PERSISTED_CREDENTIAL_ALLOWLIST = [
	{
		file: ".github/workflows/release.yml",
		name: "",
		commentMustMatch: /git push/,
	},
];

const CHECKOUT_USES =
	/^(\s*)(?:- )?uses:\s*['"]?actions\/checkout@\S+/;

// CHECKOUT_USES only understands block-style steps. `- { uses: actions/checkout@v4 }`
// is valid YAML that Actions runs happily, but it never matches — so without the
// coverage guard below the step would drop out of collectCheckouts() and the policy
// assertions would never see it. This scanner exists because model CLIs write
// .github/workflows/*.yml with no filesystem sandbox (AGENTS.md), which makes a
// silent pass on unrecognized syntax the exact failure it was written to prevent.
// Fail closed instead: anything naming actions/checkout that the recognizer cannot
// inspect fails the test with its file:line. Comment-only lines are excluded — a
// commented-out step does not run.
const CHECKOUT_MENTION = /actions\/checkout/g;
const COMMENT_LINE = /^\s*#/;

function indentOf(line) {
	const match = line.match(/^(\s*)/);
	return match ? match[1].length : 0;
}

function countByLine(entries) {
	const counts = new Map();
	for (const line of entries) counts.set(line, (counts.get(line) ?? 0) + 1);
	return counts;
}

function assertEveryMentionRecognized(lines, checkouts, file) {
	const mentioned = countByLine(
		lines.flatMap((line, index) =>
			COMMENT_LINE.test(line)
				? []
				: Array.from(line.match(CHECKOUT_MENTION) ?? [], () => index + 1),
		),
	);
	const recognized = countByLine(checkouts.map((checkout) => checkout.line));

	const unrecognized = [];
	for (const [line, count] of [...mentioned].sort((a, b) => a[0] - b[0])) {
		if ((recognized.get(line) ?? 0) >= count) continue;
		unrecognized.push(`${file}:${line}: ${lines[line - 1].trim()}`);
	}

	assert.deepEqual(
		unrecognized,
		[],
		`checkout syntax the scanner cannot inspect (rewrite as a block-style step, or teach CHECKOUT_USES to match it): ${unrecognized.join(" | ")}`,
	);
}

function collectCheckouts(content, file) {
	const lines = content.split(/\r?\n/);
	const checkouts = [];
	for (let usesIndex = 0; usesIndex < lines.length; usesIndex++) {
		if (!CHECKOUT_USES.test(lines[usesIndex])) continue;

		const usesIndent = indentOf(lines[usesIndex]);
		let start = usesIndex;
		for (let i = usesIndex; i >= 0; i--) {
			const dash = lines[i].match(/^(\s*)- /);
			if (dash && dash[1].length <= usesIndent) {
				start = i;
				break;
			}
		}

		const stepIndent = indentOf(lines[start]);
		let end = start;
		for (let i = start + 1; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "") continue;
			if (/^\s*#/.test(line)) {
				end = i;
				continue;
			}
			if (indentOf(line) <= stepIndent) break;
			end = i;
		}

		let commentStart = start;
		for (let i = start - 1; i >= 0; i--) {
			const line = lines[i];
			if (line.trim() === "" || /^\s*#/.test(line)) {
				commentStart = i;
				continue;
			}
			break;
		}
		while (commentStart < start && lines[commentStart].trim() === "") {
			commentStart++;
		}

		const block = lines.slice(commentStart, end + 1).join("\n");
		const nameMatch = block.match(/^\s+- name:\s*(.+)$/m) ?? block.match(/^\s+name:\s*(.+)$/m);
		const persistMatch = block.match(/^\s+persist-credentials:\s*['"]?(true|false)['"]?\s*(?:#.*)?$/m);
		checkouts.push({
			file,
			name: nameMatch ? nameMatch[1].trim() : "",
			persistCredentials: persistMatch ? persistMatch[1] === "true" : null,
			block,
			line: usesIndex + 1,
		});
	}
	assertEveryMentionRecognized(lines, checkouts, file);
	return checkouts;
}

function allowlistKey(entry) {
	return `${entry.file}::${entry.name}`;
}

function assertCheckoutPolicy(checkouts, allowlist) {
	const remaining = new Map(allowlist.map((entry) => [allowlistKey(entry), entry]));

	for (const checkout of checkouts) {
		const key = allowlistKey(checkout);
		const allowed = remaining.get(key);
		if (allowed) {
			assert.match(
				checkout.block,
				allowed.commentMustMatch,
				`${checkout.file}:${checkout.line} is allowlisted but has no YAML comment matching ${allowed.commentMustMatch}`,
			);
			assert.notEqual(
				checkout.persistCredentials,
				false,
				`${checkout.file}:${checkout.line} is allowlisted for persisted auth but sets persist-credentials: false`,
			);
			remaining.delete(key);
			continue;
		}

		assert.equal(
			checkout.persistCredentials,
			false,
			`${checkout.file}:${checkout.line} (${checkout.name || "unnamed"}) must set persist-credentials: false or be allowlisted`,
		);
	}

	assert.equal(
		remaining.size,
		0,
		`allowlist entries did not match exactly one checkout each: ${[...remaining.keys()].join(", ")}`,
	);
}

function workflowFiles() {
	const dir = ".github/workflows";
	return [
		...readdirSync(dir)
			.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
			.map((name) => join(dir, name))
			.sort(),
		"action.yml",
	];
}

test("every actions/checkout sets persist-credentials: false or is allowlisted", () => {
	const checkouts = workflowFiles().flatMap((file) =>
		collectCheckouts(readFileSync(file, "utf8"), file),
	);
	assert.equal(
		checkouts.length,
		EXPECTED_CHECKOUT_COUNT,
		`expected exactly ${EXPECTED_CHECKOUT_COUNT} actions/checkout steps, found ${checkouts.length}; bump EXPECTED_CHECKOUT_COUNT deliberately when adding or removing one`,
	);
	assertCheckoutPolicy(checkouts, PERSISTED_CREDENTIAL_ALLOWLIST);
});

test("allowlisted checkouts document why persisted git credentials are required", () => {
	for (const entry of PERSISTED_CREDENTIAL_ALLOWLIST) {
		const checkouts = collectCheckouts(readFileSync(entry.file, "utf8"), entry.file);
		const matches = checkouts.filter((checkout) => checkout.name === entry.name);
		assert.equal(
			matches.length,
			1,
			`${entry.file} name=${JSON.stringify(entry.name)} must identify exactly one checkout`,
		);
		assert.match(matches[0].block, entry.commentMustMatch);
		assert.match(matches[0].block, /#/);
	}
});

test("scanner fails closed on a checkout that neither disables persistence nor is allowlisted", () => {
	const yaml = [
		"jobs:",
		"  review:",
		"    steps:",
		"      - name: Checkout review target",
		"        uses: actions/checkout@v4",
		"        with:",
		"          fetch-depth: 0",
	].join("\n");
	const checkouts = collectCheckouts(yaml, "example.yml");
	assert.equal(checkouts.length, 1);
	assert.equal(checkouts[0].persistCredentials, null);
	assert.throws(
		() => assertCheckoutPolicy(checkouts, []),
		/persist-credentials: false or be allowlisted/,
	);
});

test("scanner accepts persist-credentials: false and rejects a stale allowlist entry", () => {
	const yaml = [
		"jobs:",
		"  review:",
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          persist-credentials: false",
	].join("\n");
	const checkouts = collectCheckouts(yaml, "example.yml");
	assert.equal(checkouts[0].persistCredentials, false);
	assertCheckoutPolicy(checkouts, []);
	assert.throws(
		() =>
			assertCheckoutPolicy(checkouts, [
				{ file: "missing.yml", name: "", commentMustMatch: /git push/ },
			]),
		/did not match exactly one checkout/,
	);
});

test("scanner rejects a flow-mapping checkout instead of silently skipping it", () => {
	// Valid YAML, runs on Actions, never matches CHECKOUT_USES. Before the coverage
	// guard this yielded zero checkouts and assertCheckoutPolicy passed on nothing.
	const yaml = [
		"jobs:",
		"  review:",
		"    steps:",
		"      - { uses: actions/checkout@v4 }",
	].join("\n");
	assert.throws(
		() => collectCheckouts(yaml, "example.yml"),
		/example\.yml:4: - \{ uses: actions\/checkout@v4 \}/,
	);
});

test("scanner rejects unrecognized checkout syntax even when it sets persist-credentials: false", () => {
	// Inspectability, not policy: the scanner may not conclude "compliant" from
	// syntax whose step boundaries it cannot resolve.
	const yaml = [
		"jobs:",
		"  review:",
		"    steps:",
		"      - {uses: actions/checkout@v4, with: {persist-credentials: false}}",
	].join("\n");
	assert.throws(() => collectCheckouts(yaml, "example.yml"), /example\.yml:4/);
});

test("one unrecognized checkout fails the scan even when the other steps are compliant", () => {
	const yaml = [
		"jobs:",
		"  review:",
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          persist-credentials: false",
		"      - { uses: actions/checkout@v4 }",
	].join("\n");
	assert.throws(
		() => collectCheckouts(yaml, "example.yml"),
		(error) => {
			assert.match(error.message, /example\.yml:7/);
			assert.doesNotMatch(error.message, /example\.yml:4/);
			return true;
		},
	);
});

test("a commented-out checkout is not treated as an unrecognized step", () => {
	const yaml = [
		"jobs:",
		"  review:",
		"    steps:",
		"      # - uses: actions/checkout@v4  (dropped; the job clones its own copy)",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          persist-credentials: false",
	].join("\n");
	const checkouts = collectCheckouts(yaml, "example.yml");
	assert.equal(checkouts.length, 1);
	assert.equal(checkouts[0].line, 5);
});

test("weekly-eval git push authenticates with GH_TOKEN instead of persisted checkout credentials", () => {
	const weekly = readFileSync(".github/workflows/weekly-eval.yml", "utf8");
	assert.match(weekly, /persist-credentials:\s*false/);

	const compare = weekly.match(
		/      - name: Compare with previous week and commit report\n([\s\S]*?)(?=\n      - name:|$)/,
	);
	assert.ok(compare, "Compare with previous week and commit report step must exist");
	const script = compare[1];
	assert.match(
		script,
		/credential\.helper='!f\(\) \{ echo username=x-access-token; echo "password=\$GH_TOKEN"; \}; f'/,
		"compare step must use a credential helper that reads GH_TOKEN from the environment",
	);
	assert.match(script, /git -c credential\.helper= \\/);
	assert.match(script, /push origin HEAD:main/);
	assert.doesNotMatch(script, /extraheader/);
	assert.doesNotMatch(script, /base64/);
	assert.doesNotMatch(
		script,
		/credential\.helper="/,
		"helper must be single-quoted so bash does not expand GH_TOKEN into git argv",
	);
});
