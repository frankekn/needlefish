import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "ts-backend-slop-swallow",
  kind: "positive",
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
      { pattern: "swallow|catch|silent|mask|suppress|hide|default|empty.*string|missing" },
    ],
    anchorFile: "src/store.ts",
    anchorLineRange: [6, 8],
  },
};

export default spec;
