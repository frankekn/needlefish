export type Screened =
	| { readonly kind: "clean" }
	| { readonly kind: "redacted"; readonly text: string; readonly count: number }
	| { readonly kind: "withheld" };

export const WITHHELD_MESSAGE =
	"Needlefish withheld GitHub output: it contained a credential value available to this run.";

const REDACTED = "[redacted]";

// Case-insensitive because the review-state marker stores lowercased finding
// titles. An unterminated private-key block is redacted to the end of the
// text because check summaries are truncated before they reach the screen,
// which can cut a block ahead of its END line.
const CREDENTIAL_SHAPES: readonly RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{36,}\b/gi,
	/\bgithub_pat_[A-Za-z0-9_]{50,}\b/gi,
	/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gi,
	/\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gi,
	/\bAKIA[0-9A-Z]{16}\b/gi,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/gi,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----|[\s\S]*$)/gi,
];

const CREDENTIAL_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|CREDENTIAL)/i;
const NAME_LIST_SUFFIX = /(_ENV_VARS|_FILES|_PASSTHROUGH)$/i;
const CREDENTIAL_VALUE = /^(?=[!-~]*[A-Za-z])(?=[!-~]*[0-9])[!-~]{20,}$/;

export function credentialValuesFromEnv(
	env: Readonly<Record<string, string | undefined>>,
): readonly string[] {
	const values = new Set<string>();
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) continue;
		if (!CREDENTIAL_NAME.test(name) || NAME_LIST_SUFFIX.test(name)) continue;
		if (CREDENTIAL_VALUE.test(value)) values.add(value);
	}
	return [...values];
}

function screenLeaf(text: string, loweredKnown: readonly string[]): Screened {
	const lowered = text.toLowerCase();
	if (loweredKnown.some((value) => lowered.includes(value))) {
		return { kind: "withheld" };
	}
	let count = 0;
	let screened = text;
	for (const shape of CREDENTIAL_SHAPES) {
		screened = screened.replace(shape, () => {
			count++;
			return REDACTED;
		});
	}
	return count === 0 ? { kind: "clean" } : { kind: "redacted", text: screened, count };
}

export function screenText(text: string, knownValues: readonly string[]): Screened {
	return screenLeaf(text, knownValues.map((value) => value.toLowerCase()));
}

function parseJson(payload: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
	try {
		return { ok: true, value: JSON.parse(payload) };
	} catch {
		return { ok: false };
	}
}

export function screenPayload(payload: string, knownValues: readonly string[]): Screened {
	const parsed = parseJson(payload);
	if (!parsed.ok) return screenText(payload, knownValues);
	const loweredKnown = knownValues.map((value) => value.toLowerCase());
	let withheld = false;
	let count = 0;
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") {
			const leaf = screenLeaf(value, loweredKnown);
			if (leaf.kind === "withheld") withheld = true;
			if (leaf.kind !== "redacted") return value;
			count += leaf.count;
			return leaf.text;
		}
		if (Array.isArray(value)) return value.map(walk);
		if (typeof value === "object" && value !== null) {
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, walk(item)]),
			);
		}
		return value;
	};
	const screened = walk(parsed.value);
	if (withheld) return { kind: "withheld" };
	return count === 0
		? { kind: "clean" }
		: { kind: "redacted", text: JSON.stringify(screened), count };
}
