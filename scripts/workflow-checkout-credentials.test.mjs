import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument } from "yaml";

// Parses the workflow YAML; it does not pattern-match the source text. Each
// actions/checkout step must set persist-credentials: false, or be on the allowlist
// below with a YAML comment documenting why persisted git auth is required.
//
// This was a line/regex scanner through five rounds of review, and each round found
// another way to spell the same reference past it: a flow mapping (`- { uses: ... }`),
// "actions\/checkout@v4" (YAML 1.2 solidus escape), "actions/checkout@v4", a
// double-quoted line continuation splitting the literal across two lines, anchors and
// aliases, and finally a quoted key combined with an escaped value, which evaded the
// key match and the value match at once. Every fix closed one syntactic axis and
// exposed the next, because a regex over YAML has an unbounded number of them.
//
// Parsing ends that: the parser resolves quoting, escapes, flow vs block style,
// anchors and block scalars before this file sees a single value, so an obfuscated
// reference arrives as the same string as a plain one and is policed identically.
// What matters is what the step RESOLVES to, which is also exactly what Actions runs.
//
// Why this scanner exists at all: persist-credentials: true writes the job token into
// the workspace's .git/config. That is a filesystem channel, and the runner env
// allowlist (buildRunnerEnv in src/shared/codex.ts, which builds from {} and never
// copies GITHUB_TOKEN/GH_TOKEN) does not cover it. Model CLIs run against these trees
// without a filesystem sandbox (AGENTS.md). This guards a different door from the env
// allowlist, not the same one twice.

// A FLOOR, deliberately not an equality — do not "tighten" this to assert.equal.
//
// What it guards: workflowFiles() decides which files get scanned at all, and the
// parse-based scan can only speak about files that are in that set. If checkouts
// leave that set — a workflow renamed to a non-YAML extension, or moved to a path
// outside .github/ — nothing remains to parse and the scan goes quiet. The count
// falling below the floor is the only signal of that coverage loss. (It does NOT
// catch a checkout *added* somewhere unscanned: the six here stay intact and the
// floor stays green. Only the scan set itself fixes that — hence the .github
// recursion, and hence scanRepository() following local `uses: ./…` references to
// wherever their action.yml actually lives.)
//
// Why not equality: a checkout being *added* is already fully policed — it is
// resolved by the parser and must set persist-credentials: false or be allowlisted.
// Equality adds no security signal over the floor, and it breaks on merge: any
// concurrently-open PR that legitimately adds a workflow checkout passes its own CI,
// merges cleanly (different files), and lands a main that fails an equality this
// branch could not have known to bump.
const MINIMUM_CHECKOUT_COUNT = 6;

const PERSISTED_CREDENTIAL_ALLOWLIST = [
	{
		file: ".github/workflows/release.yml",
		name: "",
		commentMustMatch: /git push/,
	},
];

const CHECKOUT_ACTION = /^actions\/checkout(?:@|$)/;
// `uses: ./path` runs a composite action whose metadata lives at path/action.yml,
// resolved from the repository root. Such an action can run its own checkout.
const LOCAL_ACTION = /^\.{1,2}\//;

function parseWorkflow(content, file) {
	const lineCounter = new LineCounter();
	const doc = parseDocument(content, { lineCounter });
	const problem = doc.errors[0] ?? doc.warnings[0];
	if (problem) {
		const line = problem.pos ? lineCounter.linePos(problem.pos[0]).line : 0;
		assert.fail(`${file}:${line}: workflow YAML does not parse cleanly: ${problem.message}`);
	}
	return { doc, lineCounter };
}

function lineOf(node, lineCounter) {
	return node?.range ? lineCounter.linePos(node.range[0]).line : 0;
}

function scanWorkflow(content, file) {
	const { doc, lineCounter } = parseWorkflow(content, file);
	const checkouts = [];
	const localActions = [];
	// Anchors may be referenced repeatedly and may even recurse. Visiting each
	// resolved node once terminates; the effect on the count is fail-closed, since a
	// step reused through N aliases is counted once and can only push the total down
	// toward the floor, never hide a policy violation.
	const seen = new Set();

	const deref = (node) => (isAlias(node) ? node.resolve(doc) : node);

	const scalarValue = (node) => {
		const resolved = deref(node);
		return isScalar(resolved) ? resolved.value : undefined;
	};

	const pairsNamed = (map, key) =>
		map.items.filter((pair) => scalarValue(pair.key) === key);

	const describe = (map, usesPair, comment) => {
		const withPair = pairsNamed(map, "with")[0];
		const withMap = withPair ? deref(withPair.value) : undefined;
		const persistPair = isMap(withMap) ? pairsNamed(withMap, "persist-credentials")[0] : undefined;
		const persistRaw = persistPair ? scalarValue(persistPair.value) : undefined;
		// Actions treats inputs as strings, so `false` and "false" mean the same thing.
		const persistCredentials =
			persistRaw === undefined || persistRaw === null ? null : String(persistRaw) === "true";

		return {
			file,
			name: String(scalarValue(pairsNamed(map, "name")[0]?.value) ?? "").trim(),
			persistCredentials,
			comment: comment ?? "",
			// For a step reached through an alias this is the anchor's definition site,
			// which is where an author would have to make the fix.
			line: lineOf(usesPair.key ?? map, lineCounter),
		};
	};

	const visit = (node, comment) => {
		const resolved = deref(node);
		if (!resolved || seen.has(resolved)) return;
		if (!isMap(resolved) && !isSeq(resolved)) return;
		seen.add(resolved);

		const attached = resolved.commentBefore ?? comment ?? "";

		if (isSeq(resolved)) {
			resolved.items.forEach((item, index) => {
				// A comment before the FIRST item is hoisted onto the sequence itself,
				// so item 0 inherits it; later items carry their own commentBefore.
				visit(item, index === 0 ? attached : (deref(item)?.commentBefore ?? ""));
			});
			return;
		}

		// No duplicate-`uses:` guard here on purpose: the parser's uniqueKeys check
		// rejects a repeated key as a parse error before this code runs, so such a
		// guard would be unreachable. The test below pins that it is the parser's job.
		const usesPair = pairsNamed(resolved, "uses")[0];
		if (usesPair) {
			const uses = scalarValue(usesPair.value);
			if (typeof uses === "string") {
				const ref = uses.trim();
				if (CHECKOUT_ACTION.test(ref)) {
					checkouts.push(describe(resolved, usesPair, attached));
				} else if (LOCAL_ACTION.test(ref)) {
					localActions.push({ ref, line: lineOf(usesPair.key ?? resolved, lineCounter) });
				}
			}
		}

		for (const pair of resolved.items) {
			visit(pair.value, deref(pair.value)?.commentBefore ?? "");
		}
	};

	visit(doc.contents, "");
	return { checkouts, localActions };
}

function collectCheckouts(content, file) {
	return scanWorkflow(content, file).checkouts;
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
				checkout.comment,
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
// actions/checkout, and a file the scanner never opens is a file it cannot police.
// Recursing the whole .github tree rather than allowlisting known directories means a
// new location does not need this list updated to be covered. Plus the repo-root
// action.yml, the published action surface, which lives outside .github/.
function workflowFiles(root = ".") {
	return [...yamlFilesUnder(join(root, ".github")), join(root, "action.yml")];
}

// Directory listing alone cannot find every composite action: `uses: ./tools/thing`
// puts action.yml anywhere in the repo, and enumerating candidate directories is the
// same losing game as enumerating spellings was. So follow the references instead.
// Start from the files that run by virtue of their location (workflows, root
// action.yml) and walk every local `uses: ./…` to its metadata, transitively. That
// set is closed under reachability: an action nothing references never runs, and one
// that does is scanned wherever it lives.
//
// A reference with no metadata file fails the scan rather than being skipped — the
// workflow would break at runtime anyway, and "the target is missing" must not be a
// way to leave a checkout uninspected.
function scanRepository(root = ".") {
	const queue = [...workflowFiles(root)];
	const scanned = new Set();
	const checkouts = [];

	while (queue.length > 0) {
		const file = queue.shift();
		if (scanned.has(file)) continue;
		scanned.add(file);

		const scan = scanWorkflow(readFileSync(file, "utf8"), file);
		checkouts.push(...scan.checkouts);

		for (const { ref, line } of scan.localActions) {
			const dir = join(root, ref);
			const metadata = [join(dir, "action.yml"), join(dir, "action.yaml")].find((path) =>
				existsSync(path),
			);
			assert.ok(
				metadata,
				`${file}:${line}: uses: ${ref} but no action.yml or action.yaml exists there, so its steps cannot be inspected`,
			);
			queue.push(metadata);
		}
	}

	return { checkouts, scanned: [...scanned] };
}

test("every actions/checkout sets persist-credentials: false or is allowlisted", () => {
	const { checkouts } = scanRepository();
	assert.ok(
		checkouts.length >= MINIMUM_CHECKOUT_COUNT,
		`expected at least ${MINIMUM_CHECKOUT_COUNT} actions/checkout steps, found ${checkouts.length}; checkouts left the scanned file set, so lower the floor only if they are genuinely gone`,
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
		assert.match(matches[0].comment, entry.commentMustMatch);
		assert.notEqual(matches[0].comment, "", "an allowlisted checkout must carry a YAML comment");
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

// The obfuscations that defeated the five regex generations. Each must now be
// RESOLVED and policed like any other checkout, not merely rejected as unreadable.
const OBFUSCATIONS = {
	"flow mapping": ["      - { uses: actions/checkout@v4 }"],
	"solidus escape": ['      - uses: "actions\\/checkout@v4"'],
	"unicode escape": ['      - uses: "actions\\u002Fcheckout@v4"'],
	"line continuation": ['      - uses: "actions/check\\', '          out@v4"'],
	"quoted key": ['      - "uses": actions/checkout@v4'],
	"quoted key and escaped value": ['      - "uses": "actions\\/checkout@v4"'],
	"unicode-escaped key and value": ['      - "\\u0075ses": "actions\\u002Fcheckout@v4"'],
	"folded block scalar": ["      - uses: >-", "          actions/checkout@v4"],
	"literal block scalar": ["      - uses: |-", "          actions/checkout@v4"],
	"single-quoted": ["      - uses: 'actions/checkout@v4'"],
};

test("every known obfuscation resolves to a policed checkout", () => {
	for (const [label, step] of Object.entries(OBFUSCATIONS)) {
		const yaml = ["jobs:", "  a:", "    steps:", ...step].join("\n");
		const checkouts = collectCheckouts(yaml, "sneaky.yml");
		assert.equal(checkouts.length, 1, `${label}: must resolve to exactly one checkout`);
		assert.equal(checkouts[0].persistCredentials, null, `${label}: persistence is on by default`);
		assert.throws(
			() => assertCheckoutPolicy(checkouts, []),
			/persist-credentials: false or be allowlisted/,
			`${label}: must fail the policy`,
		);
	}
});

test("an obfuscated checkout that does disable persistence is accepted", () => {
	// The mirror of the test above: the scanner reads the real value, so a compliant
	// step written in an unusual style passes rather than being rejected for its style.
	const yaml = [
		"jobs:",
		"  a:",
		"    steps:",
		'      - { "uses": "actions\\/checkout@v4", with: { persist-credentials: false } }',
	].join("\n");
	const checkouts = collectCheckouts(yaml, "sneaky.yml");
	assert.equal(checkouts.length, 1);
	assert.equal(checkouts[0].persistCredentials, false);
	assertCheckoutPolicy(checkouts, []);
});

test("YAML anchors and aliases resolve to policed checkouts", () => {
	const variants = {
		"anchor on a uses: value": [
			"jobs:",
			"  a:",
			"    steps:",
			"      - uses: &checkout actions/checkout@v4",
			"  b:",
			"    steps:",
			"      - uses: *checkout",
		],
		"anchor on an unrelated key": [
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
		const checkouts = collectCheckouts(lines.join("\n"), "alias.yml");
		assert.ok(checkouts.length >= 1, `${label}: the aliased checkout must be found`);
		assert.throws(
			() => assertCheckoutPolicy(checkouts, []),
			/persist-credentials: false or be allowlisted/,
			`${label}: must fail the policy`,
		);
	}
});

test("a commented-out checkout is not a step", () => {
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

test("a step declaring uses: twice is rejected by the parser, not silently last-wins", () => {
	// Ambiguity is a bypass shape: if the scanner read the first `uses:` and Actions
	// ran the second, a checkout could hide behind a benign-looking step.
	const yaml = [
		"jobs:",
		"  a:",
		"    steps:",
		"      - uses: actions/setup-node@v4",
		"        uses: actions/checkout@v4",
	].join("\n");
	assert.throws(
		() => collectCheckouts(yaml, "dup.yml"),
		/dup\.yml:\d+: workflow YAML does not parse cleanly: Map keys must be unique/,
	);
});

test("a workflow that does not parse fails with its file and line", () => {
	const yaml = ["jobs:", "  a:", "    steps:", "      - uses: [unterminated"].join("\n");
	assert.throws(() => collectCheckouts(yaml, "broken.yml"), /broken\.yml:\d+: workflow YAML does not parse/);
});

test("every uses: form the repo relies on stays acceptable", () => {
	// Fail closed on obfuscation, not on legitimate variety.
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
		"      - uses: ./.github/actions/setup",
		"      - uses: owner/repo/sub/dir@main",
		"      - uses: docker://alpine:3.19",
	].join("\n");
	const checkouts = collectCheckouts(yaml, "legit.yml");
	assert.equal(checkouts.length, 2, "both checkouts recognized, the other four forms ignored");
	assertCheckoutPolicy(checkouts, []);
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
			["runs:", "  using: composite", "  steps:", "    - uses: actions/checkout@v4"].join("\n"),
		);

		const files = workflowFiles(root);
		assert.ok(
			files.includes(join(root, ".github", "actions", "setup", "action.yml")),
			`composite action metadata must be in the scan set: ${files.join(", ")}`,
		);

		const checkouts = files.flatMap((file) => collectCheckouts(readFileSync(file, "utf8"), file));
		assert.throws(
			() => assertCheckoutPolicy(checkouts, []),
			/actions[/\\]setup[/\\]action\.yml:4 .*must set persist-credentials: false or be allowlisted/,
		);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function withFixtureRepo(build) {
	const root = mkdtempSync(join(tmpdir(), "needlefish-checkout-scan-"));
	try {
		mkdirSync(join(root, ".github", "workflows"), { recursive: true });
		writeFileSync(join(root, "action.yml"), "name: root\n");
		build(root, (relative, lines) => {
			const path = join(root, relative);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, lines.join("\n"));
		});
		return build.result;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

test("a local composite action outside .github is followed and scanned", () => {
	// The directory recursion cannot reach this one and the floor cannot see it: the
	// workflow checkouts stay intact. Only following the `uses: ./…` reference finds it.
	withFixtureRepo((root, write) => {
		write(".github/workflows/review.yml", [
			"jobs:",
			"  review:",
			"    steps:",
			"      - uses: actions/checkout@v4",
			"        with:",
			"          persist-credentials: false",
			"      - uses: ./tools/prepare",
		]);
		write("tools/prepare/action.yml", [
			"runs:",
			"  using: composite",
			"  steps:",
			"    - uses: actions/checkout@v4",
		]);

		const { checkouts, scanned } = scanRepository(root);
		assert.ok(
			scanned.includes(join(root, "tools", "prepare", "action.yml")),
			`referenced composite action must be scanned: ${scanned.join(", ")}`,
		);
		assert.throws(
			() => assertCheckoutPolicy(checkouts, []),
			/tools[/\\]prepare[/\\]action\.yml:4 .*must set persist-credentials: false or be allowlisted/,
		);
	});
});

test("local action references are followed transitively", () => {
	withFixtureRepo((root, write) => {
		write(".github/workflows/review.yml", [
			"jobs:",
			"  review:",
			"    steps:",
			"      - uses: ./tools/outer",
		]);
		write("tools/outer/action.yml", [
			"runs:",
			"  using: composite",
			"  steps:",
			"    - uses: ./tools/inner",
		]);
		write("tools/inner/action.yml", [
			"runs:",
			"  using: composite",
			"  steps:",
			"    - uses: actions/checkout@v4",
		]);

		const { checkouts, scanned } = scanRepository(root);
		assert.ok(scanned.includes(join(root, "tools", "inner", "action.yml")));
		assert.equal(checkouts.length, 1);
		assert.throws(
			() => assertCheckoutPolicy(checkouts, []),
			/tools[/\\]inner[/\\]action\.yml:4 /,
		);
	});
});

test("a local action reference with no metadata file fails the scan", () => {
	withFixtureRepo((root, write) => {
		write(".github/workflows/review.yml", [
			"jobs:",
			"  review:",
			"    steps:",
			"      - uses: ./tools/missing",
		]);
		assert.throws(
			() => scanRepository(root),
			/review\.yml:4: uses: \.\/tools\/missing but no action\.yml or action\.yaml exists there/,
		);
	});
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
