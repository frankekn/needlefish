# needlefish — session bootstrap

1. READ `docs/operating-manual.md` (Read tool, this session) before any non-trivial
   change. It defines the risk tiers, verification moves, and the pre-send self-test.
2. READ `AGENTS.md` for structure, conventions, and anti-patterns.
3. After context compaction: re-read both before continuing — do not work from the
   compacted summary of them.

High-risk seams (manual §3): `src/core/verdict.ts` and `src/shared/normalize.ts`
(verdict integrity), `src/shared/codex.ts` / `runner-process.ts` (runner sandbox,
fail-closed), `prompts/*.md` (policy-bearing source). Changes there need the manual's
full treatment, whatever the diff size.
