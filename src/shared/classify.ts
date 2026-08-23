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
// `.claude/` is an agent-config tree, not prose: its Markdown (skills, commands,
// subagent definitions, and the README/docs that describe them) instructs agents.
// It was previously excluded only by accident — nothing under it matched
// DOCS_DIR or USER_FACING_BASENAME — which left `.claude/README.md` and
// `.claude/docs/*.md` riding the fast path. Exclude it by design instead.
const POLICY_DIR = /(^|\/)(prompts?|instructions?|\.claude)(\/|$)/i;
const DOCS_DIR = /(^|\/)docs?\//i;
// Portable repo-policy filenames (any directory). Not target-repo nouns: these
// are the files coding agents treat as review/instruction policy. A CLAUDE.md
// is policy-bearing wherever it sits — agents read the nearest one for the
// directory they are editing, so `docs/CLAUDE.md` instructs edits to `docs/**`
// exactly as a root CLAUDE.md instructs the repo. Path, not content, is all the
// classifier can see, so the basename alone must disqualify the fast path.
const REPO_POLICY_BASENAME = /^(agents|claude)(\.[a-z0-9_-]+)*\.md$/i;
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
// path, an agent-config path, or an AGENTS.md/CLAUDE.md-shaped repo-policy
// file. review() also requires surface === "docs".
export function isDocsFastPathEligible(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (!DOCS_EXT.test(normalized)) return false;
  if (POLICY_DIR.test(normalized)) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (REPO_POLICY_BASENAME.test(base)) return false;
  if (DOCS_DIR.test(normalized)) return true;
  return USER_FACING_BASENAME.test(base);
}
