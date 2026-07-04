## Do now

1. **Extract the duplicated `git`/`gh` process wrappers and repo-input collection.**
   **Files:** `src/adapters/local.ts`, `src/adapters/github.ts`, new `src/shared/process.ts`, possibly new `src/shared/repo.ts`.
   Both adapters define their own `spawnSync` wrappers, error formatting, diff collection, `AGENTS.md` reading, changed-file classification, and `Bundle` construction. The local adapter has `git`, `gh`, `fetchPrMeta`, and bundle creation inline; the GitHub adapter repeats `gh`, `git`, changed-file collection, `AGENTS.md`, PR metadata, and bundle construction.    
   **Small change:** add a tiny `runText()` / `runJson()` helper and a `collectReviewBundle()` helper that accepts already-resolved mode-specific inputs. Keep `local.ts` and `github.ts` as orchestration adapters only. This improves module boundaries and makes most of the IO behavior testable without changing the review flow.

2. **Make CLI parsing a typed IO boundary.**
   **Files:** `src/cli.ts`, optionally new `src/cli/args.ts`.
   The current parser mutates one object, uses `Number(...)` directly for `--pr`, consumes missing option values as `undefined`, ignores unknown flags, and mixes help-side effects into parsing.  The main path then relies on the parsed shape to decide GitHub/local mode and rejects only `--github` without a truthy PR number. 
   **Small change:** move parsing to a pure `parseArgs(argv): CliCommand` function with a discriminated union such as `{ kind: "local" | "github" | "help" | "version"; ... }`. Validate positive integer `--pr`, required values for `--base`, `--repo`, and `--focus`, and reject unknown flags. This is a high-leverage test seam and avoids adding a CLI framework.

3. **Tighten untrusted JSON handling, but do not add a validation library yet.**
   **Files:** `src/shared/schema.ts`, `src/shared/codex.ts`, `src/adapters/local.ts`, `src/adapters/github.ts`.
   The repo already has useful normalizers, but they accept `any`, coerce aggressively, and mix domain types with input normalization in one 244-line module.    `extractJson()` also returns `any`, and PR metadata from `gh` is shaped with `any` maps in both adapters.   
   **Small change:** change `extractJson(): unknown`, `normalizeReview(raw: unknown)`, and `normalizeMap(raw: unknown)`. Add two or three local helpers like `isRecord`, `stringField`, and `arrayField`. Split only if it stays mechanical: `src/shared/types.ts` for stable internal types and `src/shared/normalize.ts` for model/API boundary parsing. Also add a small `normalizePrMeta()` for GitHub CLI/API output. This raises type safety at the actual IO boundaries without bringing in Zod, Valibot, Octokit, or a broader schema framework.

4. **Add a minimal test suite around pure seams.**
   **Files:** `package.json`, `tsconfig.json`, plus tests near `src/shared/schema.ts`, `src/core/verdict.ts`, `src/shared/classify.ts`, `src/shared/codex.ts`, and the new CLI parser.
   The package currently has only `review` and `check` scripts.  There are already several pure functions whose behavior matters: verdict derivation, classification rules, JSON extraction, normalizers, rendering, and CLI parsing.  
   **Small change:** use Node 20’s built-in test runner with `tsx`, for example `"test": "node --test --import tsx 'src/**/*.test.ts'"`. Start with five tests: valid/invalid `normalizeFinding`, empty findings verdict, blocking residual risk verdict, a couple of classify examples, and CLI parse errors. No new dependency is needed.

5. **Factor the prompt-call boilerplate inside `src/core/review.ts`, not the review strategy.**
   **Files:** `src/core/review.ts`.
   `reviewSmall()` and `reviewLarge()` both build prompts, call Codex, extract JSON, normalize, validate the checked/summary fields, run the critic, derive a verdict, and assemble `ReviewResult`.  
   **Small change:** add helpers like `runPromptReview(promptName, replacements, repoPath)`, `runCritic(candidate, patchText, bundle)`, and `toReviewResult(raw, bundle)`. Do not split map/deep/critic into classes or a workflow engine. The goal is just to make the orchestration easier to read and unit-test.

6. **Do the recall-stability TODO, but only as a narrow targeted sweep.**
   **Files:** `FUTURE_TODO.md`, `src/core/review.ts`, new `prompts/gating-sweep.md` or a small reuse of `prompts/deep.md`.
   This is the TODO with the strongest evidence: the notes say the trigger work was validated, precision was clean, but the over-block class is detected only about two-thirds of the time on some single local runs. 
   **Small change:** add one optional “gating predicate sweep” that runs only when the diff appears to touch `can*`, `may*`, `approve`, `submit`, `transition`, policy, route, or enablement predicates. Merge those findings into the candidate set before the critic. Avoid parallel critics or global deeper review. This directly addresses the measured gap without broadening the architecture.

7. **Clean up small type/ergonomic rough edges while touching the files.**
   **Files:** `src/adapters/github.ts`, `package.json`, `README.md`.
   `src/adapters/github.ts` has an unused-looking `ghText()` helper and a few loose types such as `Record<string, ...>` for verdict mapping and `surface: any` in changed-file collection.  The package already declares a bin and a Node engine but no `packageManager`, while the README instructs users to use Corepack and pnpm.  
   **Small change:** delete unused helpers, change verdict maps to `Record<Verdict, ...>`, return `ChangedFile[]` instead of `{ surface: any }[]`, and add `"packageManager": "pnpm@..."` once the repo’s actual pnpm version is chosen. Keep the source-run `tsx` bin for now.

## Defer

1. **Action packaging as `action.yml`.**
   **Files:** `FUTURE_TODO.md`, `README.md`, `package.json`, `bin/needlefish`.
   This is useful for external adoption, but the current repo already documents a reusable workflow path and the package is still private/source-run via `tsx`.    Defer until the process/repo seams and tests exist; then `action.yml` is mostly packaging rather than a behavior change. The TODO itself is reasonable, just not the next smallest improvement. 

2. **Issue-comment commands.**
   **Files:** `FUTURE_TODO.md`, future GitHub workflow/adapter files.
   `@needlefish recheck`, `review`, and `explain` add event routing, permissions, comment parsing, idempotency, and UI decisions. The current workflow already covers `pull_request` and manual `workflow_dispatch`.   Defer until users actually need comment-driven operation.

3. **Multi-repo config.**
   **Files:** `FUTURE_TODO.md`, future `src/shared/config.ts`.
   A config file for base branch, severity gates, and focus defaults is plausible, but it introduces another IO boundary and precedence rules. The current CLI already supports `--base`, `--focus`, `--deep`, `--repo`, and `--pr`.  The TODO should stay, but wait until repeated flags become real friction across several repos. 

4. **Full dist build / publishable package.**
   **Files:** `package.json`, `tsconfig.json`, `bin/needlefish`.
   For local/private use, running TypeScript through repo-local `tsx` is acceptable and clearly documented.  A `dist/` build, `exports`, publish metadata, and compiled bin are worth doing only with action packaging or public npm distribution.

5. **Deeper `--deep` behavior after instrumentation.**
   **Files:** `FUTURE_TODO.md`, `src/core/review.ts`, prompts.
   The TODO notes that `--deep` currently widens prompt framing.  Before adding extra call-site archaeology, first log enough run metadata to know whether misses come from mapping, deep review, critic pruning, or model variance. Defer broadening `--deep` until that evidence exists.

## Skip

1. **Skip the repair lane / `--fix` for this repo’s current identity.**
   **Files:** `FUTURE_TODO.md`, `src/cli.ts`, `README.md`.
   The project is explicitly read-only in the README, and `--fix` currently parses only to print an unimplemented message.   The TODO would require mutating branches, pushing, rollback behavior, trust boundaries, and substantially different testing. 
   **Recommendation:** skip it for v0.x. Either keep the friendly error hidden from help, or remove the flag until there is a real product decision to become a fixing agent.

2. **Skip “smart prior-findings verification” for `--recheck`.**
   **Files:** `src/cli.ts`, `README.md`.
   The current behavior is honest: `--recheck` runs a full review and says smart verification is TODO.  The README already says every push re-triggers action mode and `--recheck` is only a local affordance. 
   **Recommendation:** keep `--recheck` as an alias/message at most. Avoid building stateful prior-finding verification unless local incremental review becomes a core workflow.

3. **Skip a second parallel critic model for now.**
   **Files:** `FUTURE_TODO.md`, `src/core/review.ts`, `prompts/critic.md`.
   The critic already has a tight pruning contract: it must delete weak findings, correct severity inflation, and not add new findings.   A second critic adds cost and disagreement handling without addressing the specific measured gap. Prefer the targeted gating sweep above; revisit critic parallelism only with metrics showing critic instability.

4. **Skip new frameworks and large abstractions.**
   **Files:** repo-wide.
   This codebase is still small: one CLI, two adapters, one core orchestrator, shared schema/render/classify/codex helpers, and prompt files. The most useful changes are typed boundaries, small shared helpers, and tests. Adding Commander, Zod, Octokit, a workflow engine, plugin APIs, or dependency injection containers would make the structure heavier than the current problem requires.
