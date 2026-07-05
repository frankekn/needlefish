import type { Surface } from "./schema.js";

const RULES: { test: RegExp; surface: Surface }[] = [
  { test: /(^|\/)\.github\/workflows\/.+\.ya?ml$/i, surface: "workflow" },
  { test: /(^|\/)node_modules\//i, surface: "dependency" },
  {
    test: /(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.lock|go\.mod|go\.sum|cargo\.toml|cargo\.lock|requirements\.txt|pyproject\.toml|uv\.lock|gemfile|gemfile\.lock)$/i,
    surface: "dependency",
  },
  { test: /(^|\/)(test|tests|__tests__|spec|specs)\/|\.test\.|\.spec\.|-test\.|-spec\./i, surface: "test" },
  { test: /\.md$|(^|\/)docs?\//i, surface: "docs" },
  { test: /(^|\/)(migrations?|schema|db)\//i, surface: "schema" },
  { test: /\.sql$/i, surface: "schema" },
  { test: /(^|\/)(bin|cli|cmd)\//i, surface: "cli" },
  { test: /(^|\/)(src|lib)\/api\/|(^|\/)routes?\//i, surface: "public-api" },
  {
    test: /(^|\/)\.env|\.config\.(js|ts|mjs|cjs|json|yaml|yml|toml)|(^|\/)config\/|(^|\/)\.needlefish\//i,
    surface: "config",
  },
];

export function classifySurface(file: string): Surface {
  for (const rule of RULES) {
    if (rule.test.test(file)) return rule.surface;
  }
  return "source";
}

export function classifyFiles(files: string[]): { path: string; surface: Surface }[] {
  return files.map((p) => ({ path: p, surface: classifySurface(p) }));
}
