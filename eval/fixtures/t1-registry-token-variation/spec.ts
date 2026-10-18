import type { FixtureSpec } from "../../shared/types";

const spec: FixtureSpec = {
  id: "t1-registry-token-variation",
  kind: "positive",
  tier: 1,
  defectClass: "hardcoded-credential",
  holdout: false,
  description: "Synthetic package publisher replaces the configured registry token with a source-visible write token.",
  baseFiles: {
    "README.md": `REGISTRY_TOKEN is the deployment publish credential. The registry accepts it for package writes. Rotation updates the environment.
`,
    "registry.mjs": `export function publishHeaders() {
  const token = process.env.REGISTRY_TOKEN;
  if (!token) throw new Error("REGISTRY_TOKEN required");
  return { authorization: "Bearer " + token };
}
`,
  },
  headFiles: {
    "registry.mjs": `export function publishHeaders() {
  const token = "registry-shared-publish-password";
  if (!token) throw new Error("REGISTRY_TOKEN required");
  return { authorization: "Bearer " + token };
}
`,
  },
  expected: {
    verdict: "changes_requested",
    mustFind: [{ pattern: "hard.?cod|token.{0,30}(source|literal|expos|leak|commit)|credential|secret.{0,20}(source|expos|leak)", file: "registry.mjs", lineRange: [2, 2] }],
    anchorFile: "registry.mjs",
    anchorLineRange: [2, 2],
  },
};

export default spec;
