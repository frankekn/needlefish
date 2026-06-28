# Future TODO

Deferred by design (v0.1 is read-only, local-diff + self-hosted action).

## Recall stability (from the over-block/budget trigger work)
The structural triggers in `prompts/review.md` + `prompts/deep.md` (TRIGGER A
over-block, TRIGGER B aggregate-budget) were validated on 5 PRs. Recall is
stable (3/3 on both target classes) and precision is clean (0 spurious across 9
negative-control runs), but the over-block class is detected ~2/3 of the time on
a *single* draw for some instances. Action-mode mitigates this by re-reviewing on
every push, but a single-shot local run can miss it. Idea: a cheap second
deep-style sweep focused only on changed gating predicates, or a higher
reasoning effort for the proposal pass.

## Issue-comment commands
`@needlefish recheck` / `@needlefish review` / `@needlefish explain` via `issue_comment`
trigger. v0.1 only auto-reviews on `pull_request` events.

## Repair lane (`--fix`)
Let needlefish mutate the branch and push a fix (ClawSweeper-style bounded repair
loop). v0.1 is report-only; `--fix` is parsed but errors out.

## Action packaging
Ship as a reusable `action.yml` (Docker/node20) so others can `uses: frankekn/needlefish@v1`.
v0.1 runs via workflow checkout + `pnpm review --github`.

## Multi-repo config
Per-repo config file (base branch, severity gates, focus defaults) instead of flags only.

## Critic parallelism / depth
Optional second critic model or deeper call-site archaeology (`--deep` currently only
widens prompt framing).
