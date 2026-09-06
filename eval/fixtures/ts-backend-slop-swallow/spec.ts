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
      // state it as the consequence: the error is converted to / replaced by
      // a value (""), which callers cannot distinguish from a real result, or
      // the error no longer propagates. All phrasings of the same fact.
      { pattern: "swallow|silent|mask|suppress|empty.{0,16}string|ignor.{0,20}(err|exception)|hid.{0,20}(err|fail)|(?:convert|turn|map|coerc|translat)\\w*.{0,20}(?:error|exception|throw)\\w*.{0,24}(?:to|into)\\s|(?:cannot|can no longer|can't|unable to)\\s+(?:distinguish|tell|differentiate)|(?:instead of|rather than|no longer|never|not)\\s+(?:propagat|rais|rethrow|surfac|throw)" },
    ],
    anchorFile: "src/store.ts",
    anchorLineRange: [6, 8],
  },
};

export default spec;
