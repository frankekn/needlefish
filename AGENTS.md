# PROJECT KNOWLEDGE BASE

**Generated:** 2026-06-30 11:57:07 CST
**Commit:** 853e2f8
**Branch:** main

Frank owns this. Keep replies and docs terse unless formal prose is requested.

## OVERVIEW

Needlefish is a strict TypeScript PR review CLI. It collects local or GitHub PR diffs, sends them through read-only model runners, prunes weak findings with a critic pass, and derives the final verdict deterministically from validated findings.

## STRUCTURE

```
needlefish/
├── bin/needlefish          # PATH shim; resolves repo-local tsx + src/cli.ts
├── src/cli.ts              # process entry and mode dispatch
├── src/cli/                # argument parser and CLI usage text
├── src/core/               # review orchestration and verdict derivation
├── src/adapters/           # local CLI and GitHub Action surfaces
├── src/shared/             # git/gh/process/runner/schema/render utilities
├── prompts/                # model prompt contracts; policy-bearing source
├── scripts/                # test runner and Ubuntu deploy script
└── .github/workflows/      # reusable review workflow and deploy workflow
```

`.omo/` and oracle markdown files are analysis artifacts, not shipping product paths.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| CLI flags or modes | `src/cli.ts`, `src/cli/args.ts` | `--fix` is parsed but intentionally errors in v0.2. |
| Review pipeline | `src/core/review.ts` | Small path is review + critic; large path is map + deep + critic. |
| Verdict rules | `src/core/verdict.ts` | Deterministic; do not let model prose decide pass/fail. |
| Local review | `src/adapters/local.ts` | Writes `~/.cache/needlefish/<repo>/last-review.json`. |
| GitHub review | `src/adapters/github.ts` | Posts COMMENT review plus `Needlefish` check-run. |
| Runner invocation | `src/shared/codex.ts`, `src/shared/runner-process.ts` | Timeout, retry, sandbox, and runner env behavior live here. |
| Git/PR bundle shape | `src/shared/repo.ts`, `src/shared/schema.ts` | `agentsMd` is read from target repo root only. |
| Prompt behavior | `prompts/*.md` | Must remain read-only and output JSON contracts exactly. |
| Tests | `src/**/*.test.ts`, `scripts/test.mjs` | Node test runner, no Jest/Vitest. |
| CI/deploy | `.github/workflows/*.yml`, `scripts/deploy-ubuntu.sh` | Self-hosted runner must already have `needlefish` deployed. |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `main` | function | `src/cli.ts` | Parses args and dispatches local, PR, GitHub, help, version. |
| `parseArgs` | function | `src/cli/args.ts` | Owns CLI contract and option validation. |
| `runLocal` / `runLocalPr` | functions | `src/adapters/local.ts` | Build local bundles and print/cache Markdown. |
| `runGithub` | function | `src/adapters/github.ts` | Builds PR bundle, skips stale/closed PRs, posts review/check. |
| `review` | function | `src/core/review.ts` | Chooses small vs large pipeline. |
| `deriveVerdict` | function | `src/core/verdict.ts` | Converts findings/residual risks to pass/needs_human/changes_requested. |
| `runCodex` | function | `src/shared/codex.ts` | Common runner entry for Codex, Claude, and opencode. |
| `spawnRunnerProcess` | function | `src/shared/runner-process.ts` | Subprocess timeout/output/error handling. |
| `makeBundle` | function | `src/shared/repo.ts` | Builds model context bundle with target repo `AGENTS.md`. |
| `normalizeReview` | function | `src/shared/normalize.ts` | Boundary validation for model JSON. |
| `renderMarkdown` | function | `src/shared/render.ts` | User-facing review/check output. |

## CONVENTIONS

- Use Corepack and the pinned `pnpm@10.34.4`.
- Target Node `>=20`.
- ESM only: `type: "module"`.
- TypeScript is strict/no-emit with `moduleResolution: "bundler"`.
- Use `unknown` at JSON/model/GitHub boundaries, then validate or narrow.
- All NEEDLEFISH_* boolean flags go through `envFlagOn` in `src/shared/env.ts`; only `"1"` is on.
- Keep tests beside the code path as `src/**/*.test.ts`.
- Use Node built-ins (`node:test`, `assert/strict`, `spawnSync`, temp dirs) before adding dependencies.
- Stub external CLIs in tests with temp scripts and env vars.
- Prefer structural fixes over prompt prose. If a prompt missed a bug despite having the evidence, change process/output shape first.

## ANTI-PATTERNS

- Do not customize Needlefish for one target repo. No target repo nouns, field names, fixtures, or bug-specific prompt patches.
- Do not implement `--fix` or multi-repo config unless explicitly requested.
- `--recheck` forces a full re-review (bypassing the same-head dedupe in GitHub mode); it is never incremental verification.
- Do not substitute global `AGENTS.md`, `~/.codex/*`, or CLI-injected files as target repo review policy. Only bundle `agentsMd` counts.
- Do not add new runner permissions that can mutate target repos; current model runners are read-only/sandboxed by design.

## EVAL DISCIPLINE

- Any change to prompts/ or the review pipeline ships only through an eval gate: pre-declared pass criteria, full fixture set at the default effort, confirm tier (x3 draws) on divergent fixtures. Gate fails → revert, record the data in eval/RESULTS.md anyway.
- Miss museum: every confirmed real-PR miss becomes a generic fixture (no target-repo nouns) within a week.
- Holdout fixtures (`holdout: true` in the spec) are sealed at authoring time: never run them while iterating on prompt wording (`--holdout exclude`); final gates always include them. Each prompt-change round should add at least one new holdout.
- Single-draw full-set runs flicker by 1-2 fixtures at medium effort; never conclude a regression (or an improvement) from one draw — confirm x3 on the specific fixtures first.
- Recall is anchored (same finding must match pattern AND anchor file) and positives carry difficulty tiers 1-3; report per-tier recall, and treat any tier-1 miss as disqualifying for a runner. `meanNoisePerPositive` is the precision signal — recall gains bought with noise are not gains.
- mustFind patterns are written from the bug description at authoring time, never reverse-engineered from a model transcript — that is tuning the answer key.
- Honeypot fixtures (kind `honeypot`) are sandbox canaries: trap phrases exist only in spec files. Structured bait use sets `cheatDetectedCount > 0` and voids the report. Raw-transcript bait exposure with zero adoption or escape is recorded as `baitExposureCount` and does not void.
- Reports are comparable only when promptHash AND fixtureSetHash both match; `--resume` and `--compare` enforce this. `--baseline` refuses `--holdout` subsets.

## COMMANDS

```bash
corepack enable
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
corepack prepare "$PNPM_VERSION" --activate
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm review -- --repo /path/to/target
```

## NOTES

- `pnpm test` first checks the symlinked `bin/needlefish --version`, then runs `node --test --test-concurrency=1 --import tsx`.
- GitHub Action mode requires `gh`, a self-hosted runner, and `~/.local/bin/needlefish`; the reusable workflow does not reinstall Needlefish.
- `changes_requested` maps to a failed check-run but still posts a non-sticky COMMENT review, not a GitHub blocking review state.
- Closed PRs and stale heads must be skipped before posting.
