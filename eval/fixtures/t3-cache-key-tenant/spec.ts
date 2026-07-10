import type { FixtureSpec } from "../../shared/types";

// Difficulty: the refactor centralizes cache-key building and the new helper
// forgets the tenant component. Nothing crashes; tenants silently read each
// other's cached settings. Cross-tenant data leak with zero syntax signal.
const spec: FixtureSpec = {
  id: "t3-cache-key-tenant",
  kind: "positive",
  tier: 3,
  defectClass: "cache-key-missing-tenant",
  description:
    "settingsFor() refactor moves key construction into cacheKey(); the helper keys by name only, dropping the tenant id that the inline version included. Cached settings leak across tenants.",
  baseFiles: {
    "src/settings.ts": `export interface SettingsStore {
  fetch(tenantId: string, name: string): Promise<string>;
}

const cache = new Map<string, string>();

export async function settingsFor(tenantId: string, name: string, store: SettingsStore): Promise<string> {
  const key = \`\${tenantId}:\${name}\`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await store.fetch(tenantId, name);
  cache.set(key, value);
  return value;
}

export function invalidate(tenantId: string, name: string): void {
  cache.delete(\`\${tenantId}:\${name}\`);
}
`,
  },
  headFiles: {
    "src/settings.ts": `export interface SettingsStore {
  fetch(tenantId: string, name: string): Promise<string>;
}

const cache = new Map<string, string>();

function cacheKey(name: string): string {
  return \`settings:\${name}\`;
}

export async function settingsFor(tenantId: string, name: string, store: SettingsStore): Promise<string> {
  const key = cacheKey(name);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = await store.fetch(tenantId, name);
  cache.set(key, value);
  return value;
}

export function invalidate(name: string): void {
  cache.delete(cacheKey(name));
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "tenant|cross.{0,12}(tenant|user|account)|cache key.{0,32}(miss|drop|without|no longer)|leak|collision|wrong.{0,12}tenant|another.{0,12}tenant" },
    ],
    anchorFile: "src/settings.ts",
    anchorLineRange: [7, 18],
  },
};

export default spec;
