# Public GitHub review measurements

GitHub mode writes one versioned execution record to the `Needlefish` check's
`output.text`. The record is limited to 8 KiB of UTF-8 JSON. An oversized record
is omitted in full. Review bodies, comments, state markers, check summaries,
model inputs, findings, and verdict rules do not carry this record.

Each execution has one UUID. Check retries keep that UUID. A full recheck has a
new UUID. The record captures the repository, PR, reviewed head, Actions run,
run attempt, and job key. A missing run, attempt, or job makes workflow identity
`unknown`. The execution role remains `unknown` until a trusted dispatcher owns
that observation. Closed, stale, and same-head skips that do not create a check
also do not create a measurement record.

The runtime projection contains the typed public runner, model selector,
effort, core version, and their existing provenance. It does not read current
configuration to reconstruct a past run. The selector is not a provider-resolved
model identity. Runtime qualification remains `unqualified`. A review that fails
before returning public runtime leaves runtime `unknown`.

`summaryReviewId` identifies the created or edited summary. `inlineReviewIds`
contains only reviews that received inline findings during this execution.
Updating a summary does not transfer the new runtime to its older findings.

The initial terminal check record says `verdict_check_published`. After the
required posting and state marker succeed, an output-only PATCH changes the
record to `delivered`. This PATCH keeps the same title and summary and does not
write status or conclusion. Its failure does not change the review verdict.
The stored record then remains conservative. A failed marker or round comment
produces `partial`. Posting failures, cancellation, and superseded heads retain
separate outcomes. A force-killed process may leave no final record.

## Read records for an explicit PR head

Run the collector from this source checkout. Supply the expected workflow ID
and path for the repository that ran the job. Also supply the expected workflow
job key and its exact API-visible display name. These are an explicit operator
contract; GitHub does not expose the workflow job key in the Jobs API.

```bash
pnpm exec tsx eval/tools/review-measurements.ts owner/repo 123 \
  --head 0123456789abcdef0123456789abcdef01234567 \
  --workflow-id 123456 \
  --workflow-path .github/workflows/review.yml \
  --job-key review --job-name review
```

The collector only issues read-only `gh api` calls. It reads check envelopes,
exact workflow run attempts, and jobs. It reads at most 3 pages per list by
default, 100 items per page, and 100 API requests overall. `--max-pages` accepts
1 through 10. Each request has a 30-second timeout and a 2 MiB response limit.
No model or target configuration is read.

A record must match the requested repository, PR, and target head. The check
must have the expected name and Actions App identity. Its external round ID
and run ID must match the record. The workflow ID, path, repository, attempt,
and captured job key must also match the supplied contract. The exact display
name must uniquely identify a job in that run attempt. Named and matrix jobs
require their rendered display name. Duplicate names remain unknown. A workflow merge-ref SHA is reported as
`workflowRefSha`; it never replaces `targetHeadSha`. The Actions job check ID
is separate from the self-created `Needlefish` check ID.

The strongest supported binding is `producer_attested`. The UUID and
`external_id` are producer claims. The App slug does not prove which exact job
created the check. Custom App identity, missing metadata, conflicting runs or
attempts, and ambiguous job names remain `unknown`. No row is qualified against
an evaluation report. `evidenceStatus: delivered` requires an exact producer
binding, a completed check, and a delivered record. Other rows are partial or
unknown. Byte-identical duplicate records count once. Conflicting
records with the same execution identity are excluded and diagnosed.

Pipeline time uses `performance.now()` around `review()`, including its retries
and critic, and excludes GitHub collection and posting. An ordered connection session is one
invocation. Pipeline time includes its failed routes and final review; runtime
is the final public result's runtime. Per-route observations and dispatch roles
are not captured in this unit. Job queue time uses
GitHub job creation and start timestamps only after the job leaves `queued`.
A prefilled `started_at` on a queued job does not prove it started.
`workflowCreatedToTerminalMs` is a separate platform-time observation. True
push and trigger times remain `unknown`. Invalid or reversed clocks are unknown.
Failure and cancelled executions remain separate from successful verdicts.

The JSON report preserves unknown reasons and partial-delivery diagnostics.
`partial` describes collection and delivery completeness, not runtime
qualification. This collector covers only the requested head's visible checks.
It cannot inventory a run whose check creation failed. Adoption joins, workflow
inventory, weekly reports, dispatch roles, and production qualification are
separate work.
