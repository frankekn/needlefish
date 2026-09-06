import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "ts-backend-slop-swallow",
  kind: "positive",
  tier: 2,
  defectClass: "ai-slop-error-swallow",
  description: "Agent wraps a lookup in a defensive try/catch that swallows the missing-key error and returns an empty string, silently masking real failures for callers.",
  baseFiles: {
    "src/store.ts": `export function load(key: string, store: Map<string, string>): string {
  const value = store.get(key);
  if (value === undefined) throw new Error(\`missing: \${key}\`);
  return value;
}

export function loadAll(keys: string[], store: Map<string, string>): string[] {
  return keys.map((k) => load(k, store));
}
`,
  },
  headFiles: {
    "src/store.ts": `export function load(key: string, store: Map<string, string>): string {
  try {
    const value = store.get(key);
    if (value === undefined) throw new Error(\`missing: \${key}\`);
    return value;
  } catch {
    return "";
  }
}

export function loadAll(keys: string[], store: Map<string, string>): string[] {
  return keys.map((k) => load(k, store));
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      // Description: "swallows the missing-key error and returns an empty
      // string, silently masking real failures for callers". Reviewers also
      // state it as the consequence. Each consequence alternative is a
      // conjunction: it must name the error/failure source AND its loss (a
      // returned/empty value in its place, callers unable to distinguish it,
      // or propagation ending). "a missing key should never throw" names no
      // loss and is rejected; "converts the error to a typed result" names no
      // empty/returned value and is rejected.
      { pattern: "swallow|silent|mask|suppress|empty.{0,16}string|ignor.{0,20}(err|exception)|hid.{0,20}(err|fail)|(?=[\\s\\S]*\\b(?:error|exception|throw|threw|fail)\\w*)(?=[\\s\\S]*(?:returns?\\s+(?:\"\"|''|an?\\s+empty|a\\s+(?:legitimate|valid|stored|fabricated|default)\\s+value)|convert\\w*\\s+(?:it|the\\s+\\w+)\\s+to\\s+(?:\"\"|''|an?\\s+empty)|(?:cannot|can no longer|can't|unable to)\\s+(?:distinguish|tell|differentiate)|instead of\\s+propagat))[\\s\\S]*" },
    ],
    anchorFile: "src/store.ts",
    anchorLineRange: [6, 8],
  },
};

export default spec;
