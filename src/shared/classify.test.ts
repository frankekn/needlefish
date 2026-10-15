import assert from "node:assert/strict";
import test from "node:test";
import { classifySurface, isDocsFastPathEligible } from "./classify";

test("classifySurface identifies high-risk repo surfaces", () => {
  assert.equal(classifySurface(".github/workflows/review.yml"), "workflow");
  assert.equal(classifySurface("package.json"), "dependency");
  assert.equal(classifySurface("docs/usage.md"), "docs");
  assert.equal(classifySurface("src/api/users.ts"), "public-api");
  assert.equal(classifySurface("src/core/review.ts"), "source");
});

test("classifySurface does not treat executable files as docs from directory names", () => {
  assert.equal(classifySurface("src/api/docs/handler.ts"), "public-api");
  assert.equal(classifySurface("docs/build.ts"), "source");
  assert.equal(classifySurface("docs/cli/main.ts"), "cli");
  assert.equal(classifySurface("docs/guide.md"), "docs");
  assert.equal(classifySurface("doc/guide.md"), "docs");
  assert.equal(classifySurface("README.md"), "docs");
});

test("classifySurface keeps policy markdown as docs (prose) without promoting it over earlier rules", () => {
  assert.equal(classifySurface("prompts/review.md"), "docs");
  assert.equal(classifySurface("prompt/system.md"), "docs");
  assert.equal(classifySurface("instructions/policy.md"), "docs");
  assert.equal(classifySurface("AGENTS.md"), "docs");
  assert.equal(classifySurface("src/AGENTS.md"), "docs");
  assert.equal(classifySurface("CLAUDE.md"), "docs");
});

test("classifySurface rule order is unchanged for non-docs surfaces", () => {
  assert.equal(classifySurface(".github/workflows/docs.yml"), "workflow");
  assert.equal(classifySurface("docs/.github/workflows/ci.yml"), "workflow");
  assert.equal(classifySurface("pnpm-lock.yaml"), "dependency");
  assert.equal(classifySurface("node_modules/foo/index.js"), "dependency");
  assert.equal(classifySurface("src/foo.test.ts"), "test");
  assert.equal(classifySurface("test/app.ts"), "test");
  assert.equal(classifySurface("docs/foo.test.ts"), "test");
  assert.equal(classifySurface("test/README.md"), "test");
  assert.equal(classifySurface("migrations/001.sql"), "schema");
  assert.equal(classifySurface("schema/foo.ts"), "schema");
  assert.equal(classifySurface("db/foo.ts"), "schema");
  assert.equal(classifySurface("foo.sql"), "schema");
  assert.equal(classifySurface("bin/cli.ts"), "cli");
  assert.equal(classifySurface("cli/main.ts"), "cli");
  assert.equal(classifySurface("lib/api/foo.ts"), "public-api");
  assert.equal(classifySurface("routes/index.ts"), "public-api");
  assert.equal(classifySurface(".env"), "config");
  assert.equal(classifySurface("app.config.ts"), "config");
  assert.equal(classifySurface("config/app.yaml"), "config");
  assert.equal(classifySurface(".needlefish/foo"), "config");
  // .md still wins over later rules, same as before the directory-match removal.
  assert.equal(classifySurface("schema/README.md"), "docs");
  assert.equal(classifySurface("bin/README.md"), "docs");
  assert.equal(classifySurface("src/api/README.md"), "docs");
  assert.equal(classifySurface("config/README.md"), "docs");
});

test("isDocsFastPathEligible is a generic user-facing-docs allowlist", () => {
  assert.equal(isDocsFastPathEligible("docs", "docs/guide.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "doc/guide.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "packages/pkg/docs/api.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "README.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "README.zh-TW.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "CHANGELOG.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "CONTRIBUTING.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "src/api/docs/handler.ts"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/build.ts"), false);
  assert.equal(isDocsFastPathEligible("docs", "prompts/review.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "prompt/system.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "instructions/policy.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/prompts/review.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "src/AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "DESIGN.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".github/workflows/review.yml"), false);
});

// An agent-instruction file is policy wherever it sits: agents read the nearest
// one for the directory being edited, so a nested copy is as policy-bearing as
// the root one. Before this rule, only a root CLAUDE.md/GEMINI.md failed closed
// (and by accident -- it matched no allowlist entry); any copy under a docs/ or
// doc/ directory matched DOCS_DIR and took the deterministic pass with zero
// model calls.
test("isDocsFastPathEligible excludes CLAUDE.md policy files anywhere in the tree", () => {
  assert.equal(isDocsFastPathEligible("docs", "CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "doc/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "packages/app/docs/guides/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "src/shared/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/claude.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "CLAUDE.local.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs\\nested\\CLAUDE.md"), false);
  // The AGENTS.md rule this mirrors, and ordinary docs, are unaffected.
  assert.equal(isDocsFastPathEligible("docs", "packages/app/AGENTS.review.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/claude-setup.md"), true);
});

// The backstop that closes the class rather than one vendor at a time: under a
// docs/ tree the DOCS_DIR blanket used to pass everything, so each new agent CLI
// filename was a fresh fail-open hole. An ALL-CAPS basename now has to be a
// recognized human-facing convention or it is reviewed. These vendor names are
// stand-ins for "a filename nobody has added a rule for yet" -- the point is
// that no rule mentions them.
test("isDocsFastPathEligible fails closed on unrecognized ALL-CAPS Markdown under docs/", () => {
  assert.equal(isDocsFastPathEligible("docs", "docs/QWEN.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/CURSOR.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/WINDSURF.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/COPILOT.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/RULES.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "doc/NEWAGENT.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "packages/app/docs/CURSOR.local.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/README.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/CHANGELOG.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/CODE_OF_CONDUCT.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/LICENSE.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/README.zh-TW.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/api-reference.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/Getting-Started.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "docs/qwen.md"), true);
});

test("isDocsFastPathEligible excludes GEMINI.md policy files anywhere in the tree", () => {
  assert.equal(isDocsFastPathEligible("docs", "GEMINI.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/GEMINI.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "doc/GEMINI.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "packages/app/docs/guides/GEMINI.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "src/shared/GEMINI.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/gemini.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "GEMINI.local.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "docs/gemini-setup.md"), true);
});

// Dot-directories are tool/agent configuration trees: skills, commands, and
// subagent definitions instruct agents, and the prose describing them is part of
// that policy. They used to be denied only incidentally, which left the two
// allowlist entries open -- `<dir>/README.md` (user-facing basename) and
// `<dir>/docs/*.md` (DOCS_DIR). No rule names .codex, .cursor or .aider; they
// are denied by shape, which is what keeps the next tool's directory covered.
test("isDocsFastPathEligible excludes dot-directory agent-config Markdown", () => {
  assert.equal(isDocsFastPathEligible("docs", ".claude/README.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".claude/docs/guide.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".claude/skills/review/SKILL.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".claude/commands/ship.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "packages/app/.claude/README.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".gemini/README.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".gemini/docs/guide.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".codex/README.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".codex/docs/notes.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".cursor/rules/style.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".aider/README.md"), false);
  assert.equal(isDocsFastPathEligible("docs", ".github/copilot-instructions.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "packages/app/.codex/docs/guide.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "claude/docs/guide.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "gemini/docs/guide.md"), true);
  assert.equal(isDocsFastPathEligible("docs", "codex/docs/guide.md"), true);
  // A dotted *file* is not a dot-directory; this rule needs a path segment.
  assert.equal(isDocsFastPathEligible("docs", "docs/.hidden-notes.md"), true);
});

test("isDocsFastPathEligible rejects a non-docs surface even when the path is eligible", () => {
  assert.equal(classifySurface("test/README.md"), "test");
  assert.equal(isDocsFastPathEligible("test", "test/README.md"), false);
  assert.equal(isDocsFastPathEligible("docs", "test/README.md"), true);
  assert.equal(isDocsFastPathEligible("source", "docs/guide.md"), false);
});
