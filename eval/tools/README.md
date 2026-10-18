# eval/tools

Command-line tools that read GitHub. None of them run in `pnpm test` against
the network; their tests stub `gh`.

- `pr2fixture.ts` mines a real PR into a fixture skeleton. See
  [`eval/fixtures-real/README.md`](../fixtures-real/README.md).
- `adoption.ts` measures how often real PRs act on Needlefish inline findings.

## adoption

```
npx tsx eval/tools/adoption.ts owner/name [owner/name ...] [--since YYYY-MM-DD] [--json]
```

Needs an authenticated `gh` with read access to every listed repo. There is no
default repo list.

A finding thread is a PR review thread whose first comment starts with a
Needlefish header (`**P2** title`, or the early `**P2 (category): title**`).
Its fate:

| fate | rule |
| --- | --- |
| addressed | PR merged and GitHub marks the thread outdated (its lines changed after posting) |
| kept | PR merged and the thread is not outdated |
| pending | PR still open |
| abandoned | PR closed without merge |

Adoption rate = addressed / (addressed + kept). The Markdown report splits it
by repo, severity, category, and ISO week of the thread's creation. Category
comes from the early header when present, otherwise from the round-state marker
in Needlefish's review body matched by file path and normalized title.
When a finding in the requested date window has no category in its header, the tool reads
all review pages, then all available edit pages for reviews whose current body
has a valid state marker.
It passes historical bodies through the same state parser to recover earlier rounds
and detect conflicts, even when current markers already supply a category.
Missing or conflicting categories remain `unknown`. An explicit header category
always takes precedence. This read-only tool does not change posted comments or
model inputs.

`--since` counts only threads created on or after that UTC date and stops
paging at the first PR last updated before it. For the weekly report, pass the
date seven days back. `--json` prints the raw per-thread rows instead of the
report.

Limits: outdated is a proxy. A rebase or an unrelated edit to the same lines
also marks a thread outdated, and a fix made elsewhere in the file does not.
Only the first 100 review threads per PR are read, with a warning on stderr if
more exist. The initial query reads the latest 50 reviews. For PRs with findings that need state categories,
the tool also reads older review pages before it requests edit history.
Deleted, null, or unparseable edits do
not supply categories, and the tool reports unavailable history on stderr. GitHub
API errors or invalid pagination fail the report. Available edit history cannot
prove that deleted or inaccessible content never had a conflicting category.

## Weekly adoption artifacts

The `needlefish-adoption-weekly` workflow runs each Monday at 06:17 UTC and
supports **Run workflow** with no inputs. Both triggers run the same collector
for `frankekn/needlefish` only. The job uses the current repository's
`github.token` with `contents: read` and `pull-requests: read`. It does not use
production tokens, accept secrets, post comments, push commits, or call models.
It skips other repositories, including forks. This is a single-repository report,
not a report across five repositories.

Each run covers the seven completed UTC days before execution, inclusive at the
start and exclusive at the end. A run on 2026-10-16 covers
`[2026-10-09T00:00:00Z, 2026-10-16T00:00:00Z)`. A delayed cron uses the actual
execution date. Finding creation selects the window. Fates reflect GitHub state
when the collector runs, so a later rerun can produce different adoption totals.

Download the run's `adoption-weekly-<run-id>-<attempt>` artifact within 90 days.
It contains the following files:

- `rows.json` contains finding rows within the UTC window.
- `report.md` renders those exact rows with the existing adoption rules.
- `collector.json` retains the collector's original JSON, including newer rows
  that the weekly wrapper excludes.
- `stderr.txt` retains collector diagnostics, including truncated threads and
  unavailable history.
- `source-sha.txt` identifies the checked-out collector source.
- `metadata.json` records the window, source, collection status, unknown category
  count, and warnings.

A failed API call or invalid collector output fails the job and saves a failure
report. An empty successful collection reports zero findings. Truncation, history
warnings, or unknown categories produce `partial` status. `collected` means the
collector finished without those signals, not that GitHub history is complete.
The existing 100-thread limit and inaccessible-history caveats still apply.
Artifacts upload even when collection fails. Setup failures before collection
can leave no report artifact and fail the upload step as well.

To produce the same files locally, use an authenticated read-only `gh` session
and a new output directory:

```sh
pnpm exec tsx eval/tools/adoption-weekly.ts /tmp/needlefish-adoption-weekly
```

## Deep concurrency preregistration

`pnpm exec tsx eval/tools/deep-concurrency.ts --plan` verifies the fixed source
and two explicit non-holdout large fixtures, then prints the paired 7-versus-3
schedule. It has no model execution mode. The [study protocol](../campaigns/deep-concurrency-v1.md)
defines resource admission, stopping, failure denominators, and evidence needed
before any timing conclusion. The study remains `NOT_RUN`.

## Historical review measurements

Adoption measurement joins are opt-in. Supply the exact workflow file, producer
job key and Jobs API display name. The collector resolves that file's workflow
ID through a read-only API call. It never guesses a job name from a key.

```bash
pnpm exec tsx eval/tools/adoption.ts owner/name --json \
  --measurement-workflow .github/workflows/review.yml \
  --measurement-job-key review --measurement-job-name review
pnpm exec tsx eval/tools/adoption-weekly.ts /tmp/needlefish-weekly \
  --measurement-workflow .github/workflows/review.yml \
  --measurement-job-key review --measurement-job-name review
```

Without these options, adoption rows and report tables retain their existing
format. With them, each finding gains a `measurement` union. Its original comment
database ID, original commit SHA and original review database ID are read from
GitHub. Only one complete, producer-attested receipt whose `inlineReviewIds`
contains that original review can join. Summary review IDs never identify a
finding round because the summary may be edited by later rounds. Legacy rows,
inaccessible identities, partial collections and conflicting receipts remain
in the adoption denominator with an explicit unknown reason. The original
severity, category, fate and author are unchanged.

Joined rows preserve the receipt's runtime provenance, unknown dispatcher role
and unqualified status. Producer-attested does not mean platform-attested or
qualified. The report groups adoption and latency by repository, lane, severity
and category. Latency samples count each check once in a group, even when one
review produced several findings. Pipeline monotonic duration, job queue time
and workflow-created-to-terminal time have separate columns. Push-to-terminal
and trigger-to-terminal times remain unknown. Unknown durations are never zero.

Measurement reads share a ceiling of 100 API requests per repository collection,
three pages per head and a 30-second, 2-MiB bound per REST response. No API write,
new credential source or model call is introduced. The scheduled weekly workflow
supplies the explicit contract for this repository's `review.yml` / `review` job.
It retains its existing token and permissions. If that token cannot read checks
or Actions metadata, the weekly artifact is partial with unknown measurements.
The weekly JSON parser preserves the join and checks its original identity,
receipt and clocks. Metadata records the finding denominator and unknown count.


## Phase 2 offline measurement

```bash
pnpm exec tsx eval/tools/qualify-phase-two.ts \
  BROAD.json DEEP.json ORACLE.json POLICY.json NEW_MEASUREMENT.json
```

Supply frozen broad/deep reports, an independent quality oracle and an explicit
policy containing all ten floors. The command validates inputs and creates a
new `measurement_only` artifact. Exit 1 preserves a quality-failure artifact;
parse or admission errors create no artifact. It never overwrites inputs or
runs models. It grants no release qualification, blind-oracle proof or policy
approval. See the [measurement contract](../contracts/issue123-phase-two-measurement.md).
