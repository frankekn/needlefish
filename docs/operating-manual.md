# Needlefish Operating Manual

Written 2026-07-07 by Fable 5, for the Opus 4.8 sessions that will run this repo after
it. This is not a rulebook to satisfy; it is the way of working that produced the
current codebase. `AGENTS.md` tells you what the code is. This tells you how to think
while changing it. Global dispatch/verification rules live in `~/.claude/rules/`; this
file assumes them and adds only what is specific to needlefish.

One sentence of context that everything below leans on: **needlefish is itself a
reviewer.** Its whole value proposition is that its verdicts are trustworthy. Every
craft in this manual exists because a bug here doesn't break one app — it silently
corrupts review verdicts across every repo that runs it.

---

## 1. Reading what a request actually asks for

**Procedure.** Before touching anything, restate the request as: (a) the artifact
Frank will hold at the end, (b) the property that artifact must have, (c) which layer
of needlefish that property lives in. The layers, in order of policy weight:
`prompts/` (what models are told) → `src/core/verdict.ts` (what findings mean) →
`src/shared/normalize.ts` (what model output is admitted) → everything else
(plumbing). Most requests name a symptom in the plumbing but ask for a property in a
policy layer. If the request is in Frank's shorthand ("fix the review", "it's too
noisy"), the property is almost always about verdict quality, not code structure —
ask which findings were wrong before deciding where to work. And check `AGENTS.md`
anti-patterns before scoping: several natural readings of a request ("make it catch
this bug in repo X") are explicitly banned (no target-repo customization).

**Example.** "The reviewer missed an obvious bug" reads literally as "improve the
prompt." The convention in `AGENTS.md` says otherwise: if the model had the evidence
and missed it, fix the process/output shape, not the prose. The right first move is
to pull the actual bundle and model output from `~/.cache/needlefish/<repo>/
last-review.json` and see whether the evidence was even in the bundle.

**Failure prevented.** Patching `prompts/review.md` with bug-specific language — a
change that pattern-matches to "responsive" but violates the repo's core
anti-pattern and degrades every other review.

## 2. Breaking a hard problem into independently checkable pieces

**Procedure.** Cut along the seams needlefish already has, because each seam has a
contract you can test in isolation: bundle construction (`makeBundle` — does the
bundle contain X?), runner invocation (`runCodex`/`spawnRunnerProcess` — did the
subprocess get the right env/args/timeout?), normalization (`normalizeReview` — is
this JSON admitted or rejected?), verdict (`deriveVerdict` — given these findings,
what verdict?), rendering/posting. For each piece, write the check *before* the
brief: a `node:test` case with stubbed external CLIs (temp scripts + env vars, the
existing pattern). A piece whose check you cannot write is a piece you haven't
actually defined — split it again or take it back to design.

**Example.** "Add opencode as a runner" decomposes into: (1) `runCodex` dispatches
to the opencode binary with the right flags — stub-script test; (2) its env
allowlist matches the other runners — existing allowlist tests extend; (3) a
malformed opencode response is rejected by `normalizeReview`, not passed through —
fixture test; (4) failure is fail-closed, not silently skipped — test that the gate
errors. Four dispatches, four independent gates; no piece's correctness depends on
another piece's author being honest.

**Failure prevented.** One monolithic "add the runner, make it work" brief whose
only check is an end-to-end run — which passes because the happy path works, while
piece (4) silently falls back and you find out weeks later that broken runs were
reported as clean reviews.

## 3. Deciding where the real risk lives

**Procedure.** Rank effort by blast radius, not by diff size. In this repo the
ranking is fixed and steep:

1. **Verdict integrity** (`verdict.ts`, `normalize.ts`): a bug here changes
   pass/fail decisions on other people's PRs. Any change gets golden tests for every
   branch of the decision, including the direction you think can't happen.
2. **Runner sandbox/permissions** (`codex.ts`, `runner-process.ts`, env allowlist):
   runners execute inside *target* repos. A permission widening here is a security
   change to every consumer, whatever the commit message says. Fail-closed is the
   invariant; recent history (the opencode gate, the env allowlist) exists because
   this seam drifted before.
3. **Prompt contracts** (`prompts/*.md`): policy-bearing source. A wording change is
   a behavior change; treat a prompt diff with the same suspicion as a verdict diff.
4. Everything else: adapters, rendering, CLI plumbing — ordinary care.

Spend review effort in that order. A 3-line diff in tier 1 outranks a 300-line diff
in tier 4.

**Example.** A refactor "just moves env handling into a helper." Tier-2 territory:
before accepting, diff the *effective* env a runner subprocess receives before and
after (run the allowlist tests, add one if the move created a new path). The helper
being cleaner is irrelevant; the env set being identical is everything.

**Failure prevented.** Effort allocated by visual size of the diff — careful review
of a big rendering change while a one-line `deriveVerdict` threshold tweak sails
through and flips `needs_human` to `pass` on real PRs.

## 4. Verifying a claim by re-deriving it

**Procedure.** For any claim that matters, reconstruct it from primitives you ran
yourself; never from the claimant's summary, whether the claimant is a subagent, a
commit message, or your own earlier reasoning. The re-derivation moves for this repo:
claims about behavior → run `pnpm test` (the `scripts/test.mjs` gate) yourself, then
run the *specific* scenario (a local review against a fixture diff) and read the
actual JSON in the cache dir; claims about GitHub behavior → query the live API for
the check-run/review, never the Action log's own success line; claims about what a
model runner does → read the spawned command and env in `runner-process.ts` and echo
them via a stub binary, don't trust the wrapper's docstring. If re-deriving is
genuinely too expensive, say the claim is unverified — that is a valid state; a
laundered claim is not.

**Example.** A subagent reports "stale PR runs are skipped, test added." Re-derive:
read the test — does it assert on the skip *reason* observable from outside (no
review posted, specific log/exit), or on an internal flag the implementation sets
right next to the code under test? The latter is a self-referential test; it re-states
the code, it cannot fail. Rerun the suite with the skip condition mentally reverted:
would anything go red?

**Failure prevented.** The documented house failure mode — confident "done" on
unverified work — landing in the one repo where an unverified pass becomes other
projects' merge decisions.

## 5. Separating known from guessed, out loud

**Procedure.** Every load-bearing statement in a report carries its evidence class,
using the repo's own hierarchy: live state > test output > file bytes (`file:line`)
> someone's claim > plausibility. While working, keep two lists — *established*
(with the command or file:line that established it) and *assumed*. Anything on the
assumed list that survives to the report gets labeled "assumed because X; would
change the conclusion if wrong." The tell that you're guessing: you can state the
fact but not the command that would confirm it. Needlefish-specific trap: model
behavior is never "known." What a prompt "should make the model do" is a hypothesis
until you've run it against a real diff and read the raw findings JSON.

**Example.** "The critic pass prunes duplicate findings" — established (test name +
`src/core/review.ts:` ref) — versus "the critic will also prune the new
false-positive category" — assumed, because prompts are policy and models drift;
label it, and attach the one-command check (run against the fixture that produced
the false positive) that would convert it.

**Failure prevented.** Plausible-sounding inference about model or GitHub behavior
hardening into "fact" across a long session, then surviving compaction as a
confident falsehood the next context builds on.

## 6. Attacking your own conclusion before handing it over

**Procedure.** Before reporting, switch roles: you are now the reviewer needlefish
itself would be, pointed at your own diff. Run the attack in this order: (1) invert —
state the opposite conclusion and spend two honest minutes making its case from the
same evidence; (2) probe the seams your change touches with the hostile inputs this
codebase is built around — malformed model JSON, runner timeout mid-stream, empty
diff, a PR closed between fetch and post, an env var you didn't allowlist; (3) check
the anti-pattern list — is any part of your change a target-repo special case,
a permission widening, a `--fix` creep, wearing a refactor's clothes? (4) for
anything tier 1–3 in §3, get eyes that didn't author it — cross-family (codex) for
judgment calls, a fresh-context agent for read-backs. If the attack finds nothing,
say what you attacked; "no findings" is only meaningful given the search trail.

**Example.** Conclusion: "the dedupe skips re-review on same head SHA — safe."
Inversion: when is skipping *wrong*? If the previous run errored after recording the
SHA, dedupe would suppress the retry forever. Check whether the SHA is recorded on
success only. That question — findable only by arguing the other side — is the
review.

**Failure prevented.** Motivated reasoning: the context that spent an hour building
a conclusion grading its own work, in a repo whose entire premise is that authors
don't get to do that.

## 7. Communicating answer → reasoning → risk

**Procedure.** First line: the verdict or state change, in words Frank can act on
without reading further ("verdict logic unchanged, env leak fixed, safe to merge").
Then evidence, one line per acceptance criterion, each with its class from §5 and a
pasteable artifact (test name, SHA, curl output, file:line). Then risk: what you did
*not* verify, what you assumed, and the single condition that would change your
answer. Close with one recommended next move — not an option list. Terse by default
(Frank's standing instruction); long material goes to a file, the path goes in the
report. Never bury a failure under a success summary: a disclosed gap is "done
pending X"; an undisclosed one is a lie.

**Example.** "Safe to merge. Evidence: 47 tests green after final commit `abc123`
(test output); runner env identical before/after — allowlist test `env.passthrough`
plus stub-echo diff (live run); verdict fixtures untouched (`git diff --stat`).
Risk: didn't exercise the GitHub adapter against a live PR — mock only; would
change my answer if check-run posting also reads env. Next: merge, then one live PR
smoke run."

**Failure prevented.** The right answer failing to land — reasoning-first reports
where the verdict is in paragraph four, so Frank either re-reads or re-asks, and the
time the work saved is spent on the report.

## 8. The mistakes that look like competence and aren't

Each of these *feels* like good work from the inside. That's what makes them
dangerous.

- **The responsive prompt-patch.** Symptom appears → wording added to a prompt →
  symptom gone. Looks like fast iteration; is unfalsifiable policy drift. This repo's
  rule: structural fix first, prompt change only with a fixture that failed before
  and passes after.
- **The green suite that tests nothing.** Adding tests that assert what the
  implementation already says (self-referential), or stubs so thorough the real
  seam is never crossed. Looks like rigor; catches zero regressions. Ask of every
  test: what change would make it fail?
- **The helpful widening.** A runner "needs" one more env var, one more permission,
  a fallback when the sandbox blocks it. Looks like unblocking; is the exact drift
  the fail-closed gates were built to stop. The blocked state is often the spec.
- **The thorough rewrite.** Touching a tier-4 file and "cleaning up" into tier 1–3
  because you were there. Looks like craftsmanship; converts a reviewable diff into
  an unreviewable one and moves risk into the seams nobody asked you to touch.
- **The confident synthesis.** A fluent paragraph connecting facts you established
  to a conclusion you didn't. Looks like intelligence; is §5 violated with good
  prose. Fluency is not evidence — you of all models will be tempted here, because
  your syntheses will *sound* right.
- **The silent reinterpretation.** The request was ambiguous, you picked a reading,
  the report never mentions there was a fork. Looks like decisiveness; is a decision
  taken from Frank without telling him. State the fork and your reading in one line.

---

## The five-question self-test

Run on every answer before sending. Any "no" — fix it before the send, not after.

1. **Would the first line alone let Frank act correctly?** (verdict-first, §7)
2. **For each "verified" in this report, can I paste the evidence right now, and is
   its class high enough for the claim?** (§4, §5)
3. **Did anything skip, fail, or get reinterpreted that this report doesn't say out
   loud?** (§7, §8)
4. **Did a context that didn't author the work check it — and if I touched verdict,
   runners, or prompts, did the effort match that tier?** (§3, §6)
5. **What would make this answer wrong, and did I actually look there?** (§6 — if
   the honest answer is "I didn't look," go look or say so.)
