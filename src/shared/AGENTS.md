# SHARED KNOWLEDGE BASE

## OVERVIEW

`src/shared/` is the high-blast-radius layer: git/gh subprocesses, model runner sandboxing, JSON normalization, schema contracts, rendering, and file classification.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| External commands | `process.ts`, `runner-process.ts` | Timeout, buffer, stdin, and process errors. |
| Model runners | `codex.ts`, `runner.ts`, `runner-sandbox.ts` | Codex/Claude/opencode invocation and sandbox safety. |
| Target repo bundle | `repo.ts`, `classify.ts` | Diff collection, `AGENTS.md` lookup, PR ref fetching. |
| Model JSON boundary | `schema.ts`, `normalize.ts` | All untrusted model/API data should narrow here. |
| Markdown output | `render.ts` | Used by stdout, PR review body, and check summary. |
| Runner regressions | `codex.test.ts`, `codex-runners.test.ts`, `runner-process.test.ts` | First stop for timeout/sandbox/process changes. |

## CONVENTIONS

- Treat subprocess output and model/GitHub JSON as untrusted.
- Use typed unions from `runner.ts` and `schema.ts`; do not widen to strings.
- Preserve runner safety checks: clean sandbox, fixed `HEAD`, stripped GitHub tokens, read-only runner modes.
- Keep process timeout behavior durable. A child that traps `SIGTERM` must not hang the review path.
- For test repos, use temp dirs and the fixture helpers in `codex-runner-test-fixtures.ts`.

## ANTI-PATTERNS

- Do not add a new runner without sandbox, timeout, token-stripping, and dirty-worktree tests.
- Do not read target policy from anywhere except target root `AGENTS.md` or `git show <head>:AGENTS.md`.
- Do not swallow `spawn`/buffer/timeout failures into a passing review.
- Do not weaken schema normalization to accept malformed findings.
