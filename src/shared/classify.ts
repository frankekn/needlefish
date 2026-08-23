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
// The dot-directories are agent-config trees, not prose: their Markdown (skills,
// commands, subagent definitions, and the README/docs describing them) instructs
// agents. They were previously excluded only by accident — nothing under them
// matched DOCS_DIR or USER_FACING_BASENAME — which left `<dir>/README.md` and
// `<dir>/docs/*.md` riding the fast path. Exclude them by design instead.
const POLICY_DIR = /(^|\/)(prompts?|instructions?|\.claude|\.gemini)(\/|$)/i;
const DOCS_DIR = /(^|\/)docs?\//i;
// Portable repo-policy filenames (any directory). Not target-repo nouns: an
// entry belongs here when an agent CLI reads that filename as instructions for
// the directory it sits in — AGENTS.md (cross-vendor), CLAUDE.md, GEMINI.md.
// Such a file is policy-bearing wherever it sits: agents read the nearest one
// for the directory being edited, so `docs/CLAUDE.md` instructs edits to
// `docs/**` exactly as a root CLAUDE.md instructs the repo, and DOCS_DIR would
// otherwise hand it a blanket pass. Path, not content, is all the classifier
// can see, so the basename alone must disqualify the fast path.
const REPO_POLICY_BASENAME = /^(agents|claude|gemini)(\.[a-z0-9_-]+)*\.md$/i;
// Human-facing documentation basenames (optional locale suffix). Unknown
// Markdown fails closed rather than riding the docs fast path.
const USER_FACING_BASENAME =
  /^(readme|changelog|changes|history|news|license|licence|copying|contributing|code[-_]of[-_]conduct|security|support|authors|notice|attribution|acknowledgements?|todo)(\.[a-z0-9_-]+)*\.md$/i;
// An ALL-CAPS Markdown basename is a claim to a filename *convention*, and the
// conventions split into two kinds: human-facing (README, CHANGELOG, LICENSE —
// enumerated above) and agent-instruction (AGENTS, CLAUDE, GEMINI, and whatever
// the next agent CLI names its file). Prose is not named this way; prose is
// `guide.md`, `api-reference.md`, `Getting-Started.md`.
//
// The agent-instruction set is open-ended, so enumerating it can never be
// complete — and in this function every miss fails OPEN: an unlisted policy file
// under `docs/` gets a deterministic pass with zero model review. Inverting it
// is what closes the class: inside a docs/ tree, where DOCS_DIR would otherwise
// hand every file a blanket pass, an ALL-CAPS basename must be a *recognized*
// human-facing one or it fails closed. A new agent CLI's `docs/NEWAGENT.md` is
// then reviewed on the day it appears, with no change here.
//
// Deliberate cost: an unrecognized `docs/API.md` or `docs/ROADMAP.md` now gets a
// real model review instead of a free pass. Spending a model call on prose is
// the correct direction to be wrong in for a classifier that decides what
// escapes review. Case-sensitive on purpose — lower-case `docs/api.md` is prose.
const CONVENTIONAL_BASENAME = /^[A-Z][A-Z0-9_-]*(\.[A-Za-z0-9_-]+)*\.md$/;

export function classifySurface(file: string): Surface {
  for (const rule of RULES) {
    if (rule.test.test(file)) return rule.surface;
  }
  return "source";
}

export function classifyFiles(files: string[]): { path: string; surface: Surface }[] {
  return files.map((p) => ({ path: p, surface: classifySurface(p) }));
}

// True only for Markdown that is safe to skip model review: descriptively named
// prose in a docs/doc directory, or a recognized human-facing basename; never a
// prompts-like path, an agent-config path, a named repo-policy file, or an
// unrecognized ALL-CAPS convention name. review() also requires
// surface === "docs". Every branch that returns true is an allowlist branch:
// Markdown this function does not recognize gets reviewed, not passed.
export function isDocsFastPathEligible(file: string): boolean {
  const normalized = file.replace(/\\/g, "/");
  if (!DOCS_EXT.test(normalized)) return false;
  if (POLICY_DIR.test(normalized)) return false;
  const base = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (REPO_POLICY_BASENAME.test(base)) return false;
  const userFacing = USER_FACING_BASENAME.test(base);
  if (DOCS_DIR.test(normalized)) {
    return !CONVENTIONAL_BASENAME.test(base) || userFacing;
  }
  return userFacing;
}
