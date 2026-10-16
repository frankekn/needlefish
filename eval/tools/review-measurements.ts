import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseMeasurement, type MeasurementV1 } from "../../src/adapters/github-measurement.js";

export type GithubRead = (endpoint: string) => unknown;
type JsonRecord = Record<string, unknown>;
type Unknown = { readonly status: "unknown"; readonly reason: string };
type Duration = Unknown | { readonly status: "observed"; readonly valueMs: number; readonly clock: "github_utc" | "producer_monotonic" };
export interface MeasurementQuery {
  readonly repository: string;
  readonly prNumber: number;
  readonly targetHeadSha: string;
  readonly workflowId: number;
  readonly workflowPath: string;
  readonly maxPages: number;
}
export interface MeasurementRow {
  readonly measurement: MeasurementV1;
  readonly checkRunId: number;
  readonly checkStatus: "completed" | "in_progress" | "queued" | "unknown";
  readonly evidenceStatus: "delivered" | "partial" | "unknown";
  readonly workflowRunId: number | null;
  readonly runAttempt: number | null;
  readonly workflowRefSha: string | null;
  readonly workflowJobDatabaseId: number | null;
  readonly workflowJobCheckRunId: number | null;
  readonly binding: Unknown | { readonly status: "producer_attested" };
  readonly timestamps: { readonly checkStartedAt: string | null; readonly checkCompletedAt: string | null; readonly workflowCreatedAt: string | null; readonly jobCreatedAt: string | null; readonly jobStartedAt: string | null };
  readonly durations: {
    readonly pipelineMs: Duration;
    readonly jobQueueMs: Duration;
    readonly workflowCreatedToTerminalMs: Duration;
    readonly triggerToTerminalMs: Unknown;
    readonly pushToTerminalMs: Unknown;
  };
}
export interface MeasurementCollection {
  readonly schemaVersion: 1;
  readonly query: MeasurementQuery;
  readonly rows: readonly MeasurementRow[];
  readonly diagnostics: readonly { readonly checkRunId: number | null; readonly reason: string }[];
  readonly partial: boolean;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}
function id(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function unknown(reason: string): Unknown { return { status: "unknown", reason }; }

function utc(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === (value.length === 20 ? `${value.slice(0, -1)}.000Z` : value) ? parsed : null;
}
function timestamp(value: unknown): string | null { return typeof value === "string" && utc(value) !== null ? value : null; }
export function utcDuration(start: unknown, end: unknown): Duration {
  if (start === null || start === undefined || end === null || end === undefined) return unknown("missing_timestamp");
  const from = utc(start), to = utc(end);
  if (from === null || to === null) return unknown("invalid_timestamp");
  return to < from ? unknown("clock_order_conflict") : { status: "observed", valueMs: to - from, clock: "github_utc" };
}

function ghRead(endpoint: string): unknown {
  const result = spawnSync("gh", ["api", endpoint], { encoding: "utf8", timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("GitHub measurement read failed");
  try { return JSON.parse(result.stdout); } catch { throw new Error("GitHub measurement response was not JSON"); }
}

export function validateMeasurementQuery(input: MeasurementQuery): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(input.repository) || input.repository.length > 201 ||
      !id(input.prNumber) || !/^[a-f0-9]{40}$/.test(input.targetHeadSha) || !id(input.workflowId) ||
      !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(input.workflowPath) ||
      !Number.isSafeInteger(input.maxPages) || input.maxPages < 1 || input.maxPages > 10) throw new Error("invalid measurement query");
}

function externalRound(value: unknown): JsonRecord | null {
  if (typeof value !== "string") return null;
  try { return object(JSON.parse(value)); } catch { return null; }
}

function jobCheckId(value: unknown, repository: string): number | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    const prefix = `/repos/${repository}/check-runs/`;
    if (url.origin !== "https://api.github.com" || !url.pathname.toLowerCase().startsWith(prefix.toLowerCase())) return null;
    const suffix = url.pathname.slice(prefix.length);
    const parsed = /^[1-9]\d*$/.test(suffix) ? Number(suffix) : null;
    return id(parsed) ? parsed : null;
  } catch { return null; }
}

export function collectReviewMeasurements(query: MeasurementQuery, githubRead: GithubRead = ghRead): MeasurementCollection {
  validateMeasurementQuery(query);
  const diagnostics: { checkRunId: number | null; reason: string }[] = [];
  const report = (reason: string, checkRunId: number | null = null) => { diagnostics.push({ checkRunId, reason }); };
  let requests = 0;
  const read = (endpoint: string): unknown => {
    if (++requests > 100) throw new Error("request_limit");
    return githubRead(endpoint);
  };
  const pages = (endpoint: string, field: "check_runs" | "jobs", checkRunId: number | null): JsonRecord[] | null => {
    const rows: JsonRecord[] = [];
    for (let page = 1; page <= query.maxPages; page++) {
      let raw: JsonRecord | null;
      try { raw = object(read(`${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`)); }
      catch { report(requests > 100 ? "request_limit" : "api_read_failed", checkRunId); return null; }
      const list = raw?.[field];
      if (!Array.isArray(list) || list.length > 100 || list.some((item) => object(item) === null)) { report("invalid_api_page", checkRunId); return null; }
      for (const item of list) { const row = object(item); if (row) rows.push(row); }
      if (list.length < 100 || (typeof raw?.total_count === "number" && raw.total_count <= rows.length)) return rows;
      if (page === query.maxPages) { report("pagination_limit", checkRunId); return null; }
    }
    return rows;
  };
  const checks = pages(`repos/${query.repository}/commits/${query.targetHeadSha}/check-runs?check_name=Needlefish&filter=all`, "check_runs", null) ?? [];
  const candidates: { check: JsonRecord; measurement: MeasurementV1; bytes: string }[] = [];
  for (const check of checks) {
    const checkId = id(check.id) ? check.id : null;
    if (checkId === null || check.name !== "Needlefish" || check.head_sha !== query.targetHeadSha) { report("check_envelope_conflict", checkId); continue; }
    const text = object(check.output)?.text;
    if (typeof text !== "string" || text.length === 0) { report(check.status === "in_progress" ? "in_progress_missing_record" : "missing_record", checkId); continue; }
    let measurement: MeasurementV1;
    try { measurement = parseMeasurement(text); }
    catch { report("invalid_record", checkId); continue; }
    if (measurement.repository.toLowerCase() !== query.repository.toLowerCase() || measurement.prNumber !== query.prNumber || measurement.targetHeadSha !== query.targetHeadSha) { report("record_envelope_conflict", checkId); continue; }
    candidates.push({ check, measurement, bytes: text });
  }
  const identities = new Map<string, typeof candidates>();
  for (const candidate of candidates) {
    const record = candidate.measurement;
    const key = JSON.stringify([record.repository.toLowerCase(), record.prNumber, record.targetHeadSha, record.invocationId]);
    const entries = identities.get(key) ?? []; entries.push(candidate); identities.set(key, entries);
  }
  const rows: MeasurementRow[] = [];
  const runs = new Map<string, JsonRecord | null>();
  const jobs = new Map<string, JsonRecord[] | null>();
  for (const entries of identities.values()) {
    const candidate = entries[0];
    if (entries.some((entry) => entry.bytes !== candidate.bytes)) { for (const entry of entries) report("invocation_conflict", id(entry.check.id) ? entry.check.id : null); continue; }
    if (entries.length > 1) report("duplicate_record", id(candidate.check.id) ? candidate.check.id : null);
    const { check, measurement } = candidate;
    if (!id(check.id)) continue;
    let binding: MeasurementRow["binding"] = unknown("missing_workflow_identity");
    let run: JsonRecord | null = null, job: JsonRecord | null = null;
    const workflow = measurement.workflow;
    const app = object(check.app);
    const round = externalRound(check.external_id);
    if (app?.slug !== "github-actions" || !id(app.id)) binding = unknown("unverified_check_app");
    else if (workflow.status === "recorded") {
      if (round?.v !== 2 || round.prNumber !== measurement.prNumber || round.roundId !== measurement.invocationId || round.runId !== workflow.runId) binding = unknown("check_run_binding_conflict");
      else {
        const key = `${workflow.runId}/${workflow.runAttempt}`;
        if (!runs.has(key)) {
          try { runs.set(key, object(read(`repos/${query.repository}/actions/runs/${workflow.runId}/attempts/${workflow.runAttempt}`))); }
          catch { runs.set(key, null); report(requests > 100 ? "request_limit" : "workflow_read_failed", check.id); }
        }
        const sourceRun = runs.get(key) ?? null;
        const workflowRepository = sourceRun && object(sourceRun.repository)?.full_name;
        if (!sourceRun || !id(sourceRun.id) || String(sourceRun.id) !== workflow.runId || sourceRun.run_attempt !== workflow.runAttempt || sourceRun.workflow_id !== query.workflowId || sourceRun.path !== query.workflowPath || (typeof workflowRepository !== "string" || workflowRepository.toLowerCase() !== query.repository.toLowerCase())) binding = unknown("workflow_binding_conflict");
        else {
          run = sourceRun;
          if (!jobs.has(key)) jobs.set(key, pages(`repos/${query.repository}/actions/runs/${workflow.runId}/attempts/${workflow.runAttempt}/jobs`, "jobs", check.id));
          const allJobs = jobs.get(key);
          const matches = allJobs?.filter((item) => item.name === workflow.jobKey);
          const match = matches?.length === 1 ? matches[0] : null;
          if (!match || !id(match.id) || !id(match.run_id) || String(match.run_id) !== workflow.runId || match.run_attempt !== workflow.runAttempt || jobCheckId(match.check_run_url, query.repository) === null) binding = unknown(allJobs === null ? "jobs_incomplete" : "job_binding_conflict");
          else { job = match; binding = { status: "producer_attested" }; }
        }
      }
    }
    const expectedConclusion = measurement.outcome === "verdict"
      ? measurement.verdict === "pass" ? "success" : "failure"
      : measurement.outcome === "skipped" || measurement.outcome === "superseded" ? "neutral" : "failure";
    if (check.status === "completed" && check.conclusion !== expectedConclusion) binding = unknown("check_outcome_conflict");
    if (binding.status === "unknown") report(binding.reason, check.id);
    if (measurement.delivery !== "delivered") report(`delivery_${measurement.delivery}`, check.id);
    if (check.status !== "completed") report("check_not_terminal", check.id);
    const bound = binding.status === "producer_attested";
    const pipeline = measurement.pipeline;
    const terminal = check.status === "completed" ? check.completed_at : null;
    rows.push({
      measurement, checkRunId: check.id,
      checkStatus: check.status === "completed" || check.status === "in_progress" || check.status === "queued" ? check.status : "unknown",
      evidenceStatus: !bound ? "unknown" : check.status === "completed" && measurement.delivery === "delivered" ? "delivered" : "partial",
      workflowRunId: run && id(run.id) ? run.id : null,
      runAttempt: run && id(run.run_attempt) ? run.run_attempt : null,
      workflowRefSha: typeof run?.head_sha === "string" && /^[a-f0-9]{40}$/.test(run.head_sha) ? run.head_sha : null,
      workflowJobDatabaseId: job && id(job.id) ? job.id : null,
      workflowJobCheckRunId: job ? jobCheckId(job.check_run_url, query.repository) : null,
      binding,
      timestamps: { checkStartedAt: timestamp(check.started_at), checkCompletedAt: timestamp(terminal), workflowCreatedAt: timestamp(run?.created_at), jobCreatedAt: timestamp(job?.created_at), jobStartedAt: timestamp(job?.started_at) },
      durations: {
        pipelineMs: pipeline.status === "observed" ? { status: "observed", valueMs: pipeline.elapsedMs, clock: "producer_monotonic" } : unknown("missing_monotonic_capture"),
        jobQueueMs: !bound ? unknown("unbound_job") : job?.status !== "in_progress" && job?.status !== "completed" ? unknown("job_not_started") : utcDuration(job.created_at, job.started_at),
        workflowCreatedToTerminalMs: bound ? utcDuration(run?.created_at, terminal) : unknown("unbound_workflow"),
        triggerToTerminalMs: unknown("missing_trusted_event_time"), pushToTerminalMs: unknown("missing_trusted_push_time"),
      },
    });
  }
  return { schemaVersion: 1, query, rows, diagnostics, partial: diagnostics.some((item) => item.reason !== "duplicate_record") };
}

export function parseMeasurementArgs(argv: readonly string[]): MeasurementQuery | { readonly help: true } {
  if (argv.length === 1 && argv[0] === "--help") return { help: true };
  if (argv.length < 8) throw new Error("expected repository, PR, --head, --workflow-id and --workflow-path");
  const [repository, pr] = argv;
  const values = new Map<string, string>();
  for (let i = 2; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1];
    if (!["--head", "--workflow-id", "--workflow-path", "--max-pages"].includes(flag) || !value || values.has(flag)) throw new Error("invalid measurement option");
    values.set(flag, value);
  }
  if (!/^[1-9]\d*$/.test(pr) || !/^[1-9]\d*$/.test(values.get("--workflow-id") ?? "") || !/^[1-9]\d*$/.test(values.get("--max-pages") ?? "3")) throw new Error("invalid measurement numeric option");
  const query = { repository, prNumber: Number(pr), targetHeadSha: values.get("--head") ?? "", workflowId: Number(values.get("--workflow-id")), workflowPath: values.get("--workflow-path") ?? "", maxPages: Number(values.get("--max-pages") ?? "3") };
  validateMeasurementQuery(query); return query;
}

const USAGE = "Usage: tsx eval/tools/review-measurements.ts owner/name PR --head SHA --workflow-id ID --workflow-path .github/workflows/review.yml [--max-pages 1..10]\n";
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const query = parseMeasurementArgs(process.argv.slice(2));
    process.stdout.write("help" in query ? USAGE : `${JSON.stringify(collectReviewMeasurements(query), null, 2)}\n`);
  } catch {
    process.stderr.write(`Review measurement collection failed.\n${USAGE}`); process.exitCode = 1;
  }
}
