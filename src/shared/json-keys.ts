// JSON.parse collapses a duplicated member key silently (last value wins), so
// a response repeating `"findings"` (findings, then []) loses the findings and
// normalizes to a pass. Reject duplicates anywhere instead of trusting the
// collapsed object. The reviver cannot detect this (V8 calls it once per
// collapsed key), so this scanner walks the text: in JSON that has already
// parsed, the first token after `{` or `,` inside an object is a member name,
// so a string in that position is a key and duplicate keys fail the set check.
// Keys are compared decoded, matching what JSON.parse collided.
export function findDuplicateJsonKey(source: string): string | undefined {
	type Scope = { isObject: true; keys: Set<string> } | { isObject: false };
	const stack: Scope[] = [];
	let nextIsKey = false;
	for (let i = 0; i < source.length; ) {
		const ch = source[i];
		if (ch === '"') {
			// Skip to the closing quote, stepping over escape pairs so `\"`
			// and braces inside strings do not shift the structural scan.
			let end = i + 1;
			while (end < source.length) {
				if (source[end] === "\\") end += 2;
				else if (source[end] === '"') break;
				else end += 1;
			}
			const top = stack[stack.length - 1];
			if (top !== undefined && top.isObject && nextIsKey) {
				const key = JSON.parse(source.slice(i, end + 1)) as string;
				if (top.keys.has(key)) return key;
				top.keys.add(key);
			}
			nextIsKey = false;
			i = end + 1;
			continue;
		}
		if (ch === "{") {
			stack.push({ isObject: true, keys: new Set() });
			nextIsKey = true;
		} else if (ch === "[") {
			stack.push({ isObject: false });
			nextIsKey = false;
		} else if (ch === "}" || ch === "]") {
			stack.pop();
			nextIsKey = false;
		} else if (ch === ",") {
			nextIsKey = stack[stack.length - 1]?.isObject === true;
		} else if (ch === ":") {
			nextIsKey = false;
		}
		i += 1;
	}
	return undefined;
}

