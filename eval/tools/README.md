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
