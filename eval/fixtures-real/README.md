# eval/fixtures-real

Fixtures mined from real GitHub PR history, as opposed to the synthetic
hand-authored fixtures in `eval/fixtures/`. Same `FixtureSpec` shape (see
`eval/shared/types.ts`), same scorer (`eval/shared/score.ts`), same discovery
(`eval/run.ts` reads both `eval/fixtures/*/spec.ts` and
`eval/fixtures-real/*/spec.ts` and folds them into one fixture set —
`fixtureSetHash` covers both).

## Workflow

1. **Scout** — a separate process inventories candidate PRs (bugs caught in
   review, bugs shipped and fixed post-merge, reverts, and clean/safe PRs worth
   using as negatives) and produces a candidate list. This tool does not depend
   on how that list is produced.
2. **Curate** — a human picks which candidate PRs are actually worth mining and
   assigns each one a `--kind`:
   - `review-finding` — a reviewer caught the bug in the PR thread itself.
   - `post-merge-fix` — the bug shipped and was fixed in a later PR/commit (the
     curator adds that commit's SHA to `provenance.fixSha` by hand in step 4 —
     `pr2fixture` has no way to know it automatically).
   - `revert` — the PR is a revert of a bad change.
   - `clean-negative` — a normal safe PR with nothing wrong; used to test false
     positives, not recall.
3. **`pr2fixture`** — run the CLI to produce a skeleton `spec.ts` with real
   base/head file contents fetched from GitHub:
   ```
   npx tsx eval/tools/pr2fixture.ts --repo owner/name --pr 1234 \
     --out eval/fixtures-real/my-slug/ --kind review-finding
   ```
   The skeleton has every field a real fixture needs except the answer key:
   `mustFind`/`expected.verdict` for positives are placeholders
   (`TODO-CURATOR-*`), and `defectClass`/`description` need the human's words.
   The tool refuses to overwrite an existing `spec.ts` unless you pass `--force`.
4. **Human writes patterns** — the curator fills every `TODO-CURATOR`
   placeholder using the PR's actual review-thread evidence
   (`provenance.evidenceUrl`), **never** by reading the code diff and reverse-
   engineering what a model would find. Same discipline as `AGENTS.md`'s
   `mustFind` rule: patterns written from the code they grade are a leaked
   answer key, not an eval. Also add `anchorFile`/`anchorLineRange` once the
   defect's location is confirmed.
5. **Holdout seal** — decide whether this fixture should be sealed
   (`holdout: true`) per the discipline in `AGENTS.md` EVAL DISCIPLINE: sealed
   fixtures are never run during prompt-tuning iteration (`--holdout exclude`),
   only in final gates.
6. **Calibrate x3 draws** — before trusting a new real-PR fixture in any report,
   run it in isolation three times to check it isn't flaky:
   ```
   npx tsx eval/run.ts --draws 3 --fixtures '^my-slug$'
   ```

## Notes

- `pr2fixture` caps fetched content per file (50 KB) and per PR (400 KB total)
  and skips binary files — it aborts with a clear error rather than silently
  truncating a fixture that's too large to be a good eval case.
- No target-repo customization: strip anything specific to the source repo that
  isn't needed to reproduce the bug (see `AGENTS.md` ANTI-PATTERNS).
