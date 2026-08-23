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
  assert.equal(classifySurface(".github/workflows/review.yml"), "workflow");
  assert.equal(classifySurface(".github/workflows/docs.yml"), "workflow");
  assert.equal(classifySurface("docs/.github/workflows/ci.yml"), "workflow");
  assert.equal(classifySurface("package.json"), "dependency");
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
  assert.equal(classifySurface("src/api/users.ts"), "public-api");
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
  assert.equal(isDocsFastPathEligible("docs/guide.md"), true);
  assert.equal(isDocsFastPathEligible("doc/guide.md"), true);
  assert.equal(isDocsFastPathEligible("packages/pkg/docs/api.md"), true);
  assert.equal(isDocsFastPathEligible("README.md"), true);
  assert.equal(isDocsFastPathEligible("README.zh-TW.md"), true);
  assert.equal(isDocsFastPathEligible("CHANGELOG.md"), true);
  assert.equal(isDocsFastPathEligible("CONTRIBUTING.md"), true);
  assert.equal(isDocsFastPathEligible("src/api/docs/handler.ts"), false);
  assert.equal(isDocsFastPathEligible("docs/build.ts"), false);
  assert.equal(isDocsFastPathEligible("prompts/review.md"), false);
  assert.equal(isDocsFastPathEligible("prompt/system.md"), false);
  assert.equal(isDocsFastPathEligible("instructions/policy.md"), false);
  assert.equal(isDocsFastPathEligible("docs/prompts/review.md"), false);
  assert.equal(isDocsFastPathEligible("AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("src/AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("docs/AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("DESIGN.md"), false);
  assert.equal(isDocsFastPathEligible(".github/workflows/review.yml"), false);
});

// A CLAUDE.md is agent policy wherever it sits: agents read the nearest one for
// the directory being edited, so a nested copy is as policy-bearing as the root
// one. Before this rule, only a root CLAUDE.md failed closed (and by accident --
// it matched no allowlist entry); any CLAUDE.md under a docs/ or doc/ directory
// matched DOCS_DIR and took the deterministic pass with zero model calls.
test("isDocsFastPathEligible excludes CLAUDE.md policy files anywhere in the tree", () => {
  assert.equal(isDocsFastPathEligible("CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("doc/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("packages/app/docs/guides/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("src/shared/CLAUDE.md"), false);
  assert.equal(isDocsFastPathEligible("docs/claude.md"), false);
  assert.equal(isDocsFastPathEligible("CLAUDE.local.md"), false);
  assert.equal(isDocsFastPathEligible("docs\\nested\\CLAUDE.md"), false);
  // The AGENTS.md rule this mirrors, and ordinary docs, are unaffected.
  assert.equal(isDocsFastPathEligible("AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("docs/AGENTS.md"), false);
  assert.equal(isDocsFastPathEligible("packages/app/AGENTS.review.md"), false);
  assert.equal(isDocsFastPathEligible("prompts/review.md"), false);
  assert.equal(isDocsFastPathEligible("docs/prompts/review.md"), false);
  assert.equal(isDocsFastPathEligible("docs/guide.md"), true);
  assert.equal(isDocsFastPathEligible("docs/claude-setup.md"), true);
  assert.equal(isDocsFastPathEligible("README.md"), true);
});

// `.claude/` is an agent-config tree: skills, commands, and subagent definitions
// instruct agents, and the prose describing them is part of that policy. It used
// to fail closed only incidentally, which left the two allowlist entries open --
// `.claude/README.md` (user-facing basename) and `.claude/docs/*.md` (DOCS_DIR).
test("isDocsFastPathEligible excludes .claude agent-config Markdown", () => {
  assert.equal(isDocsFastPathEligible(".claude/README.md"), false);
  assert.equal(isDocsFastPathEligible(".claude/docs/guide.md"), false);
  assert.equal(isDocsFastPathEligible(".claude/skills/review/SKILL.md"), false);
  assert.equal(isDocsFastPathEligible(".claude/commands/ship.md"), false);
  assert.equal(isDocsFastPathEligible("packages/app/.claude/README.md"), false);
  // A normal directory that merely starts with the same letters is still docs.
  assert.equal(isDocsFastPathEligible("claude/docs/guide.md"), true);
});
