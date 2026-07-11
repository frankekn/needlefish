# Needlefish Autonomous Improvement Workflow (no human in the inner loop)

Distilled 2026-07-11 from three sources — CodeRabbit's orchestration article (plan-quality
evals, measured routing), Anthropic's AI-native org article (verification is the bottleneck),
Anthropic's skills article (machine-checkable verification beats narrated verification) —
plus a cross-family second opinion (codex gpt-5.6-sol). Adapted to this repo's existing
eval discipline (AGENTS.md) and risk tiers (docs/operating-manual.md §3).

**Scope.** The unit of work this loop runs autonomously: one improvement cycle to
prompts/ or the review pipeline — from a detected miss to a gated, commit-ready change.
Exactly one human touchpoint survives, at the very end (push/merge). Everything before
it is machine-gated: no approval pauses, no "shall I proceed", no human review inside
the loop.

**Design principles (the distillation):**
1. *PASS is never model-authored.* Every gate verdict is produced by a script that
   emits structured JSON (exit code, metrics, hashes), not by an executor saying "done".
   (codex: "remove PASS as a model-authored claim"; A3: verification skills > narration.)
2. *Plan quality is measured, not assumed.* The pre-declared eval criteria ARE the plan
   artifact; a cycle whose criteria can't be written as numbers doesn't start. (A1.)
3. *Verification depth is risk-based, not blanket.* Tier 1–3 seams get independent
   review with a different framing; tier 4 gets the machine gate only. (codex: blanket
   fresh-context re-checks duplicate cost and can reproduce the same framing error.)
4. *Routing reads a ledger, not reputation.* The synthetic-vs-real rank inversion in
   eval/RESULTS.md proves global model rankings are unsafe; route on recorded
   task-type × model × gate-outcome history. (codex; A1's "if Haiku does as well, use Haiku".)

---

## The loop

```
S0 INTAKE ─► S1 PLAN ─► S2 IMPLEMENT ─► S3 MACHINE GATE ─► S4 RISK REVIEW ─► S5 CONFIRM ─► S6 SHIP-READY
   ▲                                        │ fail              │ fail           │ fail
   └────────── auto-revert + RESULTS.md ◄───┴───────────────────┴────────────────┘
```

### S0 — Intake (signal → fixture, machine-triggered)
- Inputs: a confirmed real-PR miss, a false-positive complaint, or an eval regression.
- Action: mint a generic miss-museum fixture (no target-repo nouns — AGENTS.md
  anti-pattern) with `mustFind` written from the bug description, never from a model
  transcript. Difficulty tier assigned at authoring time.
- Machine check: fixture runs red against current prompts (`pnpm eval` on the new
  fixture fails). A fixture that doesn't fail is not a signal; discard.
- Every ~3rd cycle also seals one new holdout fixture (AGENTS.md eval discipline).

### S1 — Plan (the PRD is the eval criteria)
- Author (fable-planner or commander): one hypothesis, structural-fix-first (prompt
  prose only with a fixture that failed before and passes after — operating manual §8).
- The plan artifact is a brief containing, verbatim:
  - the failing fixture id(s),
  - pre-declared pass criteria as numbers: per-tier recall floor, `meanNoisePerPositive`
    ceiling, zero tier-1 misses, `cheatDetectedCount == 0`,
  - which risk tier (§3) the change touches → which S4 depth applies,
  - prohibitions FIRST (holdout names never appear in any brief; truncation eats tails).
- Machine check on the brief itself (brief-lint script): contains fixture ids, numeric
  criteria, tier declaration, no holdout identifiers. Lint fail → brief bounces before
  dispatch. This is the "grok bar" made executable.

### S2 — Implement (dispatch, first-party verify)
- Executor chosen from the routing ledger (see Ledger below), one worktree per cycle.
- Executor obligations, in the brief: implement, run `pnpm check && pnpm test`
  itself, run the target fixture(s), and emit a terminal evidence record —
  `{commands, exit_codes, commit_sha, promptHash, changed_files}` as JSON to a known
  path. No prose verdict is read; only the record.
- Executor first-party verification is admission to S3, not a substitute for it.

### S3 — Machine gate (substrate-produced evidence)
Run by the harness, not by any model:
- `pnpm check` and `pnpm test` exit 0 after the final commit.
- Full fixture set at default effort; single draw. Criteria from S1 checked
  numerically. `promptHash`/`fixtureSetHash` recorded; comparisons refused on mismatch
  (existing `--resume`/`--compare` enforcement).
- Honeypot canary: `cheatDetectedCount > 0` voids the run entirely.
- Diff guard: changed files ⊆ files the brief authorized. Out-of-scope diff → fail.
- Any fail → auto-revert the worktree, append the data to eval/RESULTS.md anyway
  (negative results are data), return to S1 with the failure trail attached.
  Two failed rounds on one hypothesis → the hypothesis is retired, not retried.

### S4 — Risk-based independent review (tier 1–3 only)
- Dogfood lane (all tiers, free): every PR from this loop goes through needlefish's
  own CI review; its findings are S0-grade intake. Validated on PR #16: self-review
  caught a fail-open entrypoint, an error-channel holdout leak, partial-report
  acceptance, and a JSON-escape bypass — all missed by commander verification that
  attacked only the happy and documented-leak branches. Commander verification must
  run the operating-manual §6 hostile-input attack (error channels, encodings,
  partial inputs, the "does main() even run" path) on any gate/verifier script.
- Tier 4 (plumbing/rendering): skip — S3 suffices.
- Tier 1–3 (verdict.ts, normalize.ts, runner sandbox, prompts/): one cross-family
  read-only review (codex) with a *different framing* from the implement brief —
  the reviewer gets the diff + the operating manual's §6 attack list ("invert the
  conclusion, probe with malformed JSON / timeout / empty diff / env not allowlisted"),
  NOT the original brief. Same-brief review reproduces the same blind spot.
- Reviewer output is structured findings (file:line + failure scenario). Zero
  confirmed findings → proceed. Confirmed finding → back to S2 with the finding as
  a new acceptance criterion.

### S5 — Confirm (defeat single-draw flicker)
- Divergent fixtures (changed verdicts vs baseline) re-run ×3; a shift is real only
  if it reproduces in ≥2 of 3 draws (existing eval discipline).
- Final gate includes holdouts (`--holdout` never excluded here).
- Pass → tag the run in eval/RESULTS.md with promptHash + fixtureSetHash + criteria met.

### S6 — Ship-ready (the single human touchpoint)
- Local commit on a branch, evidence pack assembled: RESULTS.md delta, gate JSON,
  confirm-draw table, review findings ledger, commit SHA.
- Push/merge waits for Frank — arrive fully prepared, ask once. This is the only
  human gate; it is outside the loop, at its terminus.

---

## Infrastructure the loop needs (what makes it human-free)

**Routing ledger (replaces markdown reputation).** One generated JSON file:
`{task_type, model, effort, brief_lint_pass, S3_outcome, retries, out_of_scope_diff}`
appended per dispatch. Routing = highest S3 pass rate for the task type, cost as
tie-break; two consecutive fails on a task type auto-escalates one tier. The dispatch
playbook stays the source of *landmines*; the ledger is the source of *ranking*.

**Heartbeat as infrastructure, not per-brief boilerplate.** Every dispatch is launched
detached with a terminal marker (`DISPATCH_EXIT=$?` baked into the wrapper shell) and a
Monitor on the log — armed in the same message as the launch. States:
`queued → running → verifying → terminal`. A run silent past 2× its historical median
is presumed dead: health-check, then re-dispatch to the same worktree with a resume
addendum. No human polling anywhere.

**Brief-lint + evidence-record scripts.** Shipped via PR #16: `scripts/brief-lint.mjs`
(S1 machine check) and `scripts/gate-verdict.mjs` (S3 → single JSON verdict), plus a
fixture manifest + kinds in eval reports. These are the "PASS is not model-authored"
principle made concrete.

**Spec-writing rules for gate/verifier briefs** (from PR #16's 12-round review cycle —
4 of ~20 findings traced to commander spec errors, not executor errors):
- Closed enums, never open types ("non-empty string" let a typo'd kind bypass tier-1).
- Completeness counts unique identities, never record counts (duplicated draw indices
  satisfied a record count).
- Cite the source-of-truth line before asserting a cross-field invariant (an assumed
  population equality was false; the executor's stop-and-report caught it).
- Structural inspection ≠ execution: lint never executes the content it inspects;
  prefer AST + conservative fail-closed classification.
- A gate that can exit 0 without emitting a verdict is fail-open — test silent-exit,
  hostile paths (spaces, symlinks), and encodings explicitly.
- Gates recompute metrics from primary records and cross-check reported aggregates;
  reported summaries are claims, not evidence — same rule as the human loop.

## What this loop deliberately does NOT automate

- Push/merge/deploy (irreversible, outward-facing — terminal gate).
- Changing the eval criteria themselves mid-cycle (that is tuning the answer key).
- Widening runner permissions or sandbox exceptions — a blocked state is often the
  spec (operating manual §8); any such change exits the loop and goes to Frank.
- Retiring or unsealing holdout fixtures.
