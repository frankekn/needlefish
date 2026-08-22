import type { Surface } from "./schema.js";

// Markdown only. A `doc/` or `docs/` directory must not classify executables
// (docs/build.ts, src/api/docs/handler.ts) — those fall through to later rules
// or source. First-match order is unchanged: workflow / dependency / test still
// win, so CI yml and tests cannot become docs.
const DOCS_EXT = /\.md$/i;

const RULES: { test: RegExp; surface: Surface }[] = [
  { test: /(^|\/)\.github\/workflows\/.+\.ya?ml$/i, surface: "workflow" },
  { test: /(^|\/)node_modules\//i, surface: "dependency" },
  {
    test: /(package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|.*\.lock|go\.mod|go\.sum|cargo\.toml|cargo\.lock|requirements\.txt|pyproject\.toml|uv\.lock|gemfile|gemfile\.lock)$/i,
    surface: "dependency",
  },
  { test: /(^|\/)(test|tests|__tests__|spec|specs)\/|\.test\.|\.spec\.|-test\.|-spec\./i, surface: "test" },
  { test: DOCS_EXT, surface: "docs" },
  { test: /(^|\/)(migrations?|schema|db)\//i, surface: "schema" },
  { test: /\.sql$/i, surface: "schema" },
  { test: /(^|\/)(bin|cli|cmd)\//i, surface: "cli" },
  { test: /(^|\/)(src|lib)\/api\/|(^|\/)routes?\//i, surface: "public-api" },
  {
    test: /(^|\/)\.env|\.config\.(js|ts|mjs|cjs|json|yaml|yml|toml)|(^|\/)config\/|(^|\/)\.needlefish\//i,
    surface: "config",
  },
];

// Model/agent instruction directories — generic shape, not a repo-specific path.
const POLICY_DIR = /(^|\/)(prompts?|instructions?)(\/|$)/i;
const DOCS_DIR = /(^|\/)docs?\//i;
// Portable repo-policy filename (any directory). Not a target-repo noun:
// this is the file coding agents treat as review/instruction policy.
const REPO_POLICY_BASENAME = /^agents(\.[a-z0-9_-]+)*\.md$/i;
// Human-facing documentation basenames (optional locale suffix). Unknown
// Markdown fails closed rather than riding the docs fast path.
const USER_FACING_BASENAME =
  /^(readme|changelog|changes|history|news|license|licence|copying|contributing|code[-_]of[-_]conduct|security|support|authors|notice|attribution|acknowledgements?|todo)(\.[a-z0-9_-]+)*\.md$/i;

export function classifySurface(file: string): Surface {
  for (const rule of RULES) {
    if (rule.test.test(file)) return rule.surface;
  }
  return "source";
}

export function classifyFiles(files: string[]): { path: string; surface: Surface }[] {
  return files.map((p) => ({ path: p, surface: classifySurface(p) }));
}

// True only for Markdown that is safe to skip model review: a docs/doc
// directory, or a well-known human-facing basename; never a prompts-like
// path or an AGENTS.md-shaped repo-policy file. review() also requires
// surface === "docs".
export function isDocsFastPathEligible(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (!DOCS_EXT.test(normalized)) return false;
  if (POLICY_DIR.test(normalized)) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (REPO_POLICY_BASENAME.test(base)) return false;
  if (DOCS_DIR.test(normalized)) return true;
  return USER_FACING_BASENAME.test(base);
}
