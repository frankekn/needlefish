# PROJECT KNOWLEDGE BASE

Frank owns this. Keep replies and docs terse unless formal prose is requested.

## OVERVIEW

Needlefish is a strict TypeScript PR review CLI. It collects local or GitHub PR diffs, sends them through isolated model runners, prunes weak findings with a critic pass, and derives the final verdict deterministically from validated findings.

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
| CLI flags or modes | `src/cli.ts`, `src/cli/args.ts` | `--fix` is parsed but intentionally errors. |
| Review pipeline | `src/core/review.ts` | Small path is review + critic; large path is map + deep + critic. |
| Verdict rules | `src/core/verdict.ts` | Deterministic; do not let model prose decide pass/fail. |
| Local review | `src/adapters/local.ts` | Writes `~/.cache/needlefish/<repo>/last-review.json`. |
| GitHub review | `src/adapters/github.ts` | Posts COMMENT review plus `Needlefish` check-run. |
| Runner invocation | `src/shared/codex.ts`, `src/shared/runner-process.ts` | Timeout, retry, target isolation, and runner env behavior live here. |
| Git/PR bundle shape | `src/shared/repo.ts`, `src/shared/schema.ts` | `agentsMd` is read from target repo root only. |
| Prompt behavior | `prompts/*.md` | Must remain read-only and output JSON contracts exactly. |
| Tests | `src/**/*.test.ts`, `scripts/test.mjs` | Node test runner, no Jest/Vitest. |
| CI/deploy | `.github/workflows/ci.yml`, `.github/workflows/deploy.yml`, `scripts/deploy-ubuntu.sh` | Own-repo required check is `needlefish-ci`; deploy waits on that SHA. |

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
- Production model CLIs intentionally run without process-level permission or sandbox restrictions on trusted self-hosted runners. Do not restore those restrictions; preserve the throwaway target clone and post-run integrity checks instead.
- Keep tests beside the code path as `src/**/*.test.ts`.
- Use Node built-ins (`node:test`, `assert/strict`, `spawnSync`, temp dirs) before adding dependencies.
- Stub external CLIs in tests with temp scripts and env vars.
- Prefer structural fixes over prompt prose. If a prompt missed a bug despite having the evidence, change process/output shape first.

## ANTI-PATTERNS

- Do not customize Needlefish for one target repo. No target repo nouns, field names, fixtures, or bug-specific prompt patches.
- Do not implement `--fix` or multi-repo config unless explicitly requested.
- `--recheck` forces a full re-review (bypassing the same-head dedupe in GitHub mode); it is never incremental verification.
- Do not substitute global `AGENTS.md`, `~/.codex/*`, or CLI-injected files as target repo review policy. Only bundle `agentsMd` counts.
- Do not weaken the throwaway clone, token stripping, fixed `HEAD`, or post-run mutation checks that isolate unrestricted model runners from the original target repo.

## EVAL DISCIPLINE

- Every pipeline/prompt change ships through an eval gate classified `gateClass: R` or `D`, declared in the report. Gate fails → revert, record the data in eval/RESULTS.md anyway.
- **Class R (recall-affecting)** — full fixture set mirroring the production lane's model and effort, confirm tier (x3 draws) on divergent fixtures, holdouts included, tier-1 = 1 absolute. Required whenever the change can alter what the models are fed (prompts/, bundle contents such as round context) or what counts as usable output (`src/shared/normalize.ts`), alter critic matching/severity semantics beyond provenance-preserving restore, or touch scoring. Mixed changes (part R, part D) are always R.
- **Class D (delivery/reliability)** — changes whose successful-path output is byte-identical to the old pipeline and whose new outputs on previously-failing inputs are subsets of artifacts the old pipeline had already admitted (candidate bag), with signals never removed and verdicts only moving more conservative. Examples: error handling, retry/timeout tuning, fail-soft restore of candidate residuals, posting/check-run plumbing. D gate = resident property suite (`final findings/residuals ⊆ candidate bag`; drift corpus replay must not throw) + x3 gate on the historical critic-drift fixture subset plus all honeypots with pre-declared zero malformed-output errors and zero cheat detections + live canary window with automatic rollback to the last-known-good install.
- The classification test is provenance containment, not motive. A change motivated by delivery that alters model inputs is R.
- Miss museum: every confirmed real-PR miss becomes a generic fixture (no target-repo nouns) within a week.
- Holdout fixtures (`holdout: true` in the spec) are sealed at authoring time: never run them while iterating on prompt wording (`--holdout exclude`); final gates always include them. Each prompt-change round should add at least one new holdout.
- Single-draw full-set runs flicker by 1-2 fixtures at medium effort; never conclude a regression (or an improvement) from one draw — confirm x3 on the specific fixtures first.
- Recall is anchored (same finding must match pattern AND anchor file) and positives carry difficulty tiers 1-3; report per-tier recall, and treat any tier-1 miss as disqualifying for a runner. `meanNoisePerPositive` is the precision signal — recall gains bought with noise are not gains.
- mustFind patterns are written from the bug description at authoring time, never reverse-engineered from a model transcript — that is tuning the answer key.
- Honeypot fixtures (kind `honeypot`) are sandbox canaries: trap phrases exist only in spec files. Structured bait use sets `cheatDetectedCount > 0` and voids the report. Raw-transcript bait exposure with zero adoption or escape is recorded as `baitExposureCount` and does not void.
- Reports are comparable only when promptHash, fixtureSetHash, AND anticheatVersion all match; `--resume` and `--compare` enforce this. `--baseline` refuses `--holdout` subsets. Reports carry `gateClass`; `--compare` requires both sides equal, and only Class R full-contract reports may anchor `--baseline`. Legacy reports without the field compare as R.

## COMMANDS

```bash
corepack enable
PNPM_VERSION=$(node -p "require('./package.json').packageManager")
corepack prepare "$PNPM_VERSION" --activate
pnpm install --frozen-lockfile
pnpm check
pnpm lint
pnpm test
pnpm review -- --repo /path/to/target
```

## NOTES

- `pnpm test` first checks the symlinked `bin/needlefish --version`, then runs `node --test --test-concurrency=1 --import tsx`.
- GitHub Action mode requires `gh`, a self-hosted runner, and `~/.local/bin/needlefish`; the reusable workflow does not reinstall Needlefish.
- `changes_requested` maps to a failed check-run but still posts a non-sticky COMMENT review, not a GitHub blocking review state.
- Closed PRs and stale heads must be skipped before posting.
- Own-repo CI is the GitHub Actions check named `needlefish-ci` (job `needlefish-ci` in `.github/workflows/ci.yml`). Mark **`needlefish-ci`** required on `main`. It runs on `ubuntu-latest` and must not reference `secrets.*`. `needlefish-deploy` is not a merge gate; it deploys `workflow_run.head_sha` after a successful `needlefish-ci` **push** to `main`. `workflow_dispatch` on `needlefish-deploy` remains for recovery. Branch protection is a repo setting, not a workflow file.
