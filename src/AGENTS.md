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

## DEPENDENCY BOUNDARIES

`pnpm lint` enforces downward relative imports: CLI -> adapters -> core -> shared.
Peers and direct imports of lower layers are allowed; types follow the same rule.
Shipping `src/` must not import `eval/`, `scripts/`, `node:test`, or test-only modules.
Only `*.test.ts` and `*test-fixtures.ts` are exempt from these boundary rules,
matching the build exclusions; ordinary lint rules still apply to those files.

The policy lives in `eslint.config.js`. `scripts/architecture-lint.test.mjs`
exercises the actual config with allowed and forbidden imports, re-exports,
type imports, and literal dynamic imports. These are specifier-based checks,
not a resolver or a proof against computed paths, aliases, or same-layer cycles.
Keep reviewing ownership and runtime side effects; do not add wrappers merely
to satisfy the layer names or move test helpers into a shipping module.

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
