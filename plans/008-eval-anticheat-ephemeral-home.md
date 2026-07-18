# 008 — Eval anti-cheat: ephemeral per-draw HOME + leaked-answer-key bait

## Problem (Frank, 2026-07-12)

Eval integrity rests on trusting CLI flags we've already proven unreliable
(grok `--sandbox read-only` does not block writes). Every runner CLI keeps
logs/session caches under `~` (`~/.codex/sessions`, `~/.grok`, `~/.pi`), so:
(a) a runner could in principle read prior-draw sessions (cross-draw
contamination), (b) an unsandboxed runner could hunt for the answer key
(`eval/fixtures/*/spec.ts`), and (c) we have no audit of what runners write.
Constraint: guards must be fully disposable — no dead files accumulating.

## Design

### G1. Ephemeral per-draw HOME (flag `NEEDLEFISH_EPHEMERAL_HOME=1`)

The per-invocation tmp dir already has the right lifecycle
(`src/shared/codex.ts:187` mkdtemp → `:222` rmSync in finally). Put
`<tmp>/home` inside it: HOME/USERPROFILE point there; whatever the CLI
writes (sessions, caches, logs) dies with the draw. Disposability is
inherited, zero new lifecycle code — same pattern as the existing
GH_CONFIG_DIR redirect (`buildRunnerEnv`, codex.ts:78).

- Auth material only, linked per runner (symlink individual FILES, never a
  directory; sessions/log dirs must not exist in the ephemeral HOME):
  codex → `~/.codex/auth.json` (+ config if required); grok → `~/.grok`
  config/credential files; pi → `~/.pi/agent/models.json` + auth store;
  opencode → `~/.opencode` auth files. The minimal set is determined
  empirically (smoke each CLI under an isolated HOME) and documented in
  code comments.
- claude runner exemption: its credential lookup goes through the macOS
  Keychain tied to the real HOME (existing comment codex.ts:35-36) — keeps
  real HOME under the flag, documented, plus `--no-session-persistence`
  already prevents session writes.
- Eval always sets the flag (eval/run.ts). Prod review: opt-in env
  (auth-token refresh written into a discarded HOME is an accepted cost in
  eval; in prod default-off until observed stable).

### G2. Answer lockdown (chmod fixtures during runs) — DEFERRED

chmod 000 on `eval/fixtures*/` during runs breaks the standing workflow of
parallel eval runs + inspect.ts from the same checkout (first finisher
restores perms under the second run). Detection (G3) + HOME isolation (G1)
cover the threat with less foot-gun; revisit as an opt-in `--paranoid`
single-run mode if G3 ever fires.

### G3. Leaked-answer-key bait + per-run canary

At fixture materialization (`eval/shared/fixture.ts:60`), plant
`.needlefish/answers.json` in the repo — present in BASE and HEAD so it
never appears in the diff under review. Content mimics a leaked answer key:
2-3 fake findings whose titles embed a per-RUN canary token (crypto uuid
generated in eval/run.ts, threaded through materialization and scoring).
G3 has two verdicts. Bait use in candidate or final findings, review text,
or another structured surface sets `cheatDetected` and voids the report.
Bait found only on raw transcript surfaces is counted in
`baitExposureCount` and does not void, but only when a healthy robustness
scan proves there was no adoption or escape. Without a healthy scan, any
canary match fails closed as `cheatDetected`. Bait lives only in the
disposable temp repo.

## Verification

- Unit: stub runner bin echoes $HOME → assert it is `<tmp>/home`, absent
  after the invocation returns (rmSync covers it); auth files reachable in
  the ephemeral HOME; claude exemption keeps real HOME.
- Unit: materialized repo contains the bait outside the diff (git diff
  base..head clean of `.needlefish/`); score flags canary-bearing findings,
  passes canary-free ones.
- Live smoke: one fixture draw per CLI runner (codex/pi/grok) with the flag
  on — format ok, auth works, no `needlefish-*` tmp dirs left behind.
- Post-merge: re-run one x3 lane (grok first — highest suspicion, no
  sandbox) and compare against the 2026-07-12 baselines; numbers within
  noise = today's matrix stands.

## Risk

`buildRunnerEnv` / runner spawn is a tier-2 seam (operating-manual §3):
review = full treatment. Effective-env diffing via stub binaries, allowlist
tests extended, fail-closed (missing auth file → runner error, never a
silent fallback to real HOME).
