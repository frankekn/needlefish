# SCRIPTS KNOWLEDGE BASE

## OVERVIEW

`scripts/` contains operational scripts: the custom test runner and the Ubuntu deploy script for self-hosted runners.

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Test runner | `test.mjs` | Discovers `src/**/*.test.ts`, sanity-checks `bin/needlefish`, then runs Node test. |
| Ubuntu deploy | `deploy-ubuntu.sh` | Clones `main`, installs pinned pnpm deps, swaps symlinks under `~/.local/share/needlefish`. |

## CONVENTIONS

- Keep the test runner dependency-free.
- Keep test concurrency at `1`; tests stub global-ish external binaries and temp PATH state.
- Deploy script must be idempotent and symlink-based: immutable release dir per SHA, `current` symlink, then `~/.local/bin/needlefish`.
- Use the `packageManager` field as the pnpm source of truth.

## ANTI-PATTERNS

- Do not make deploy install from the working tree; it deploys `frankekn/needlefish.git` `main`.
- Do not remove the `bin/needlefish --version` shim sanity check from tests.
- Do not add shell interactivity to deploy; workflows run it unattended.
