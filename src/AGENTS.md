# SRC KNOWLEDGE BASE

## OVERVIEW

`src/` is the shipping TypeScript CLI, split by surface: CLI parsing, review orchestration, adapters, and shared runtime utilities.

## STRUCTURE

```
src/
├── cli.ts          # entrypoint and mode dispatch
├── cli/            # args parser and usage contract
├── core/           # review pipeline and verdict rules
├── adapters/       # local and GitHub surfaces
└── shared/         # git/gh/process/runner/schema/render helpers
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Add/change flag | `cli/args.ts`, `cli.ts`, `cli/args.test.ts` | Keep parser and runtime behavior aligned. |
| Change review behavior | `core/` | Preserve critic pruning and deterministic verdicts. |
| Change target surfaces | `adapters/` | Local and GitHub modes differ; verify both when shared behavior changes. |
| Change external IO | `shared/process.ts`, `shared/repo.ts`, `shared/codex.ts` | Most failures are boundary errors. |
| Change JSON shape | `shared/schema.ts`, `shared/normalize.ts` | Validate unknown data before use. |

## CONVENTIONS

- Keep TypeScript strict. No `any`, `as any`, or error suppression.
- Keep helpers close until there is a third real use.
- Use readonly interfaces and narrow union types for contracts.
- Use Node standard modules directly; no new dependency for small IO/path/process work.
- Test behavior where it lives. A runner change belongs near `src/shared/*runner*.test.ts`; parser changes near `src/cli/args.test.ts`.

## ANTI-PATTERNS

- Do not add compatibility aliases for old flag/env names unless the README already documents them.
- Do not hide expected business flow in thrown exceptions; reserve throws for real failure paths.
- Do not let model output determine verdict directly.
