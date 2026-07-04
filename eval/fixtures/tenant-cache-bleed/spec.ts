import type { FixtureSpec } from "../../shared/types";

// HOLDOUT: sealed at authoring time (W2). Never used while iterating on
// prompt wording — only run at final gates. See eval/RESULTS.md.
const spec: FixtureSpec = {
  id: "tenant-cache-bleed",
  kind: "positive",
  defectClass: "tenant-cache-bleed",
  holdout: true,
  description:
    "The diff changes a profile memo key from tenant plus account to account only, so two tenants with the same account id can receive each other's profile.",
  baseFiles: {
    "src/profile.ts": `export interface Profile {
  tenant: string;
  account: string;
  displayName: string;
}

const memo = new Map<string, Profile>();

export async function readProfile(
  tenant: string,
  account: string,
  fetchProfile: (tenant: string, account: string) => Promise<Profile>,
): Promise<Profile> {
  const key = \`\${tenant}:\${account}\`;
  const cached = memo.get(key);
  if (cached) return cached;
  const profile = await fetchProfile(tenant, account);
  memo.set(key, profile);
  return profile;
}
`,
  },
  headFiles: {
    "src/profile.ts": `export interface Profile {
  tenant: string;
  account: string;
  displayName: string;
}

const memo = new Map<string, Profile>();

export async function readProfile(
  tenant: string,
  account: string,
  fetchProfile: (tenant: string, account: string) => Promise<Profile>,
): Promise<Profile> {
  const key = account;
  const cached = memo.get(key);
  if (cached) return cached;
  const profile = await fetchProfile(tenant, account);
  memo.set(key, profile);
  return profile;
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [
      { pattern: "tenant|cache|memo|cross|isolation|profile|account|wrong|bleed" },
    ],
    anchorFile: "src/profile.ts",
    anchorLineRange: [13, 18],
  },
};

export default spec;
