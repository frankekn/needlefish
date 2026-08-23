import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Line/regex scanner, not a YAML parser: Node has no YAML built-in and this
// repo's workflow tests stay dependency-free. Each `uses: actions/checkout`
// step must set persist-credentials: false, or be on the allowlist below
// with a YAML comment documenting why persisted git auth is required.

// A FLOOR, deliberately not an equality — do not "tighten" this to assert.equal.
//
// What it guards: workflowFiles() decides which files get scanned at all, and
// assertEveryMentionRecognized() can only speak about files that are in that set.
// If checkouts leave that set — a workflow renamed to a non-YAML extension, or moved
// to a path outside .github/ — no mention is left to flag and the scan goes quiet.
// The count falling below the floor is the only signal of that coverage loss.
// (Note this floor does NOT catch a checkout *added* somewhere unscanned: the six
// here stay intact and the floor stays green. Only widening workflowFiles() fixes
// that, which is why it recurses rather than listing directories.)
//
// Why not equality: a checkout being *added* is already fully policed — it must be
// recognized (assertEveryMentionRecognized) and must set persist-credentials: false
// or be allowlisted. Equality adds no security signal over the floor, and it breaks
// on merge: any concurrently-open PR that legitimately adds a workflow checkout
// passes its own CI, merges cleanly (different files), and lands a main that fails
// an equality this branch could not have known to bump.
const MINIMUM_CHECKOUT_COUNT = 6;

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

// The inverted guard. CHECKOUT_MENTION matches one literal spelling, so every round
// of review found another way to write the same reference without it:
// `"actions\/checkout@v4"` (YAML 1.2 solidus escape), `"actions\u002Fcheckout@v4"`,
// and a double-quoted line continuation splitting the literal across two lines. That
// tail has no end — \x6f, single quotes, block scalars — so stop enumerating
// spellings and invert the question. Instead of "does this line name a checkout?",
// ask "is this `uses:` value one this scanner can read at all?" and reject the file
// if it is not, checkout or otherwise. Exotic spellings then fail closed without
// anyone having to predict them.
//
// Fail closed on unparseable, NOT on unfamiliar: every form the repo actually uses
// is accepted. Today that is only `owner/repo@ref`, but local (`./path`) and
// `docker://` refs are accepted too so adding one does not break the build.
// A quoted value is fine when it is a plain scalar — closing quote on the same line,
// no backslash, so nothing can be hiding in an escape.
//
// Known false positive: a `uses:` written inside a `run: |` shell block would be
// read as a step. No such line exists here (all 11 `uses:` lines are real steps or
// inside `#` comments); if one appears, quote it differently or extend this.
const USES_LINE = /^(\s*)(?:- )?uses:\s*(.*)$/;
const PLAIN_ACTION_REF = /^[\w.-]+\/[\w./-]+@[\w./-]+$/;
const LOCAL_ACTION_REF = /^\.{1,2}\/[\w./-]+$/;
const DOCKER_ACTION_REF = /^docker:\/\/[\w.:/@-]+$/;

function inspectableUsesValue(raw) {
	// Strip a trailing YAML comment, but only when it is separated by whitespace —
	// `#` inside a ref (a docker digest) is not a comment.
	const value = raw.replace(/\s+#.*$/, "").trim();
	if (value === "") return null;

	let scalar = value;
	if (scalar.startsWith('"')) {
		// The `\\` in this class is deliberately redundant: a backslash is not in any
		// of the three ref charsets below, so an escaped value is already rejected
		// there (removing it from here fails no test — checked). It stays as the
		// explicit statement of intent, so that widening a ref charset later cannot
		// quietly re-admit \/, \u002F and friends. The closing-quote requirement is
		// NOT redundant: it is what rejects an end-of-line continuation, whose quote
		// lands on the next line.
		if (!/^"[^"\\]*"$/.test(scalar)) return null;
		scalar = scalar.slice(1, -1);
	} else if (scalar.startsWith("'")) {
		if (!/^'[^']*'$/.test(scalar)) return null;
		scalar = scalar.slice(1, -1);
	}

	if (PLAIN_ACTION_REF.test(scalar)) return scalar;
	if (LOCAL_ACTION_REF.test(scalar)) return scalar;
	if (DOCKER_ACTION_REF.test(scalar)) return scalar;
	return null;
}

function assertEveryUsesIsInspectable(lines, file) {
	const uninspectable = [];
	lines.forEach((line, index) => {
		if (COMMENT_LINE.test(line)) return;
		const match = line.match(USES_LINE);
		if (!match) return;
		if (inspectableUsesValue(match[2]) !== null) return;
		uninspectable.push(`${file}:${index + 1}: ${line.trim()}`);
	});

	assert.deepEqual(
		uninspectable,
		[],
		`uses: values this scanner cannot resolve, so it cannot prove they are not a checkout (write them as a plain owner/repo@ref): ${uninspectable.join(" | ")}`,
	);
}

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
	assertEveryUsesIsInspectable(lines, file);
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

function yamlFilesUnder(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
		a.name.localeCompare(b.name),
	)) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...yamlFilesUnder(path));
		} else if (entry.isFile() && /\.ya?ml$/.test(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

// All YAML under .github/, not just .github/workflows/. A composite action at
// .github/actions/<name>/action.yml runs its own steps, including its own
// actions/checkout, and a file the scanner never opens is a file it cannot police —
// the same fail-open as unrecognized syntax, one directory over. Recursing on the
// whole .github tree rather than allowlisting action.yml means a new location does
// not need this list updated to be covered. Plus the repo-root action.yml, the
// published action surface, which lives outside .github/.
function workflowFiles(root = ".") {
	return [...yamlFilesUnder(join(root, ".github")), join(root, "action.yml")];
}

test("every actions/checkout sets persist-credentials: false or is allowlisted", () => {
	const checkouts = workflowFiles().flatMap((file) =>
		collectCheckouts(readFileSync(file, "utf8"), file),
	);
	assert.ok(
		checkouts.length >= MINIMUM_CHECKOUT_COUNT,
		`expected at least ${MINIMUM_CHECKOUT_COUNT} actions/checkout steps, found ${checkouts.length}; checkouts left the scanned file set, so raise the floor only if they are genuinely gone`,
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

test("a checkout spelled around the literal fails closed", () => {
	// The three spellings that defeated CHECKOUT_MENTION. All resolve to
	// actions/checkout@v4 under YAML 1.2; none contains the literal on one line.
	const spellings = {
		"solidus escape": '      - uses: "actions\\/checkout@v4"',
		"unicode escape": '      - uses: "actions\\u002Fcheckout@v4"',
	};
	for (const [label, step] of Object.entries(spellings)) {
		const yaml = ["jobs:", "  a:", "    steps:", step].join("\n");
		assert.throws(
			() => collectCheckouts(yaml, "sneaky.yml"),
			/sneaky\.yml:4: .*cannot resolve|cannot resolve.*sneaky\.yml:4/s,
			`${label} must be rejected`,
		);
	}

	// Line continuation: the closing quote is on the next line, so the value is not a
	// plain scalar and the reference is split across two lines.
	const continued = [
		"jobs:",
		"  a:",
		"    steps:",
		'      - uses: "actions/check\\',
		'          out@v4"',
	].join("\n");
	assert.throws(() => collectCheckouts(continued, "sneaky.yml"), /cannot resolve/);
});

test("every uses: form the repo relies on stays inspectable", () => {
	// Guards the other direction: fail closed on unparseable, not on unfamiliar.
	const yaml = [
		"jobs:",
		"  a:",
		"    steps:",
		"      - uses: actions/checkout@v4",
		"        with:",
		"          persist-credentials: false",
		"      - uses: actions/setup-node@v4",
		"      - uses: frankekn/needlefish@v0",
		"      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0",
		"        with:",
		"          persist-credentials: false",
		'      - uses: "actions/setup-node@v4"',
		"      - uses: 'actions/setup-node@v4'",
		"      - uses: ./.github/actions/setup",
		"      - uses: owner/repo/sub/dir@main",
		"      - uses: docker://alpine:3.19",
		"      # - uses: whatever/nonsense@\\/weird",
	].join("\n");
	const checkouts = collectCheckouts(yaml, "legit.yml");
	assert.equal(checkouts.length, 2, "both plain checkouts stay recognized");
	assertCheckoutPolicy(checkouts, []);
});

test("a YAML alias cannot smuggle a checkout past the scanner", () => {
	// Actions has resolved anchors/aliases since 2025-09, so `uses: *checkout` runs.
	// It is still not a bypass, and the reason is worth pinning: aliases are
	// file-scoped, so an alias needs an `&anchor` in the SAME file, and YAML has no
	// concatenation — the anchor's value must spell out `actions/checkout`. That
	// definition line is never a plain `uses: actions/checkout@...`, so CHECKOUT_USES
	// misses it, CHECKOUT_MENTION sees it, and the coverage guard rejects the file.
	//
	// Do NOT "fix" this by teaching the mention scan to skip anchor definitions or by
	// resolving aliases: skipping the definition line is what would open the hole.
	const variants = {
		"anchor on a uses: line": [
			"jobs:",
			"  a:",
			"    steps:",
			"      - uses: &checkout actions/checkout@v4",
			"  b:",
			"    steps:",
			"      - uses: *checkout",
		],
		"anchor on a non-uses key": [
			"x-defs:",
			"  checkout: &checkout actions/checkout@v4",
			"jobs:",
			"  a:",
			"    steps:",
			"      - uses: *checkout",
		],
		"anchor on a whole step mapping": [
			"x-defs:",
			"  step: &checkout { uses: actions/checkout@v4 }",
			"jobs:",
			"  a:",
			"    steps:",
			"      - *checkout",
		],
	};

	for (const [label, lines] of Object.entries(variants)) {
		assert.throws(
			() => collectCheckouts(lines.join("\n"), "alias.yml"),
			/cannot inspect/,
			`${label}: the anchor definition must fail the coverage guard`,
		);
	}
});

test("a composite action's checkout is scanned, not just .github/workflows", () => {
	// The floor cannot see this one: adding an unprotected checkout under
	// .github/actions leaves the workflow checkouts intact, so the count stays green.
	// Only the scan set widening catches it.
	const root = mkdtempSync(join(tmpdir(), "needlefish-checkout-scan-"));
	try {
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		mkdirSync(join(root, ".github", "actions", "setup"), { recursive: true });
		writeFileSync(join(root, "action.yml"), "name: root\n");
		writeFileSync(
			join(root, ".github", "workflows", "review.yml"),
			[
				"jobs:",
				"  review:",
				"    steps:",
				"      - uses: actions/checkout@v4",
				"        with:",
				"          persist-credentials: false",
			].join("\n"),
		);
		writeFileSync(
			join(root, ".github", "actions", "setup", "action.yml"),
			["runs:", "  using: composite", "  steps:", "    - uses: actions/checkout@v4"].join(
				"\n",
			),
		);

		const files = workflowFiles(root);
		assert.ok(
			files.includes(join(root, ".github", "actions", "setup", "action.yml")),
			`composite action metadata must be in the scan set: ${files.join(", ")}`,
		);

		const checkouts = files.flatMap((file) =>
			collectCheckouts(readFileSync(file, "utf8"), file),
		);
		assert.throws(
			() => assertCheckoutPolicy(checkouts, []),
			/actions[/\\]setup[/\\]action\.yml:4 .*must set persist-credentials: false or be allowlisted/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
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
