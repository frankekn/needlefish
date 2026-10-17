import { parseMeasurement, type MeasurementV1 } from "../../src/adapters/github-measurement.js";
import { collectReviewMeasurements, readGithubMeasurement, type MeasurementRow } from "./review-measurements.js";
import type { AdoptionRow } from "./adoption.js";

export interface FindingIdentity {
  readonly commentId: number;
  readonly originalHeadSha: string;
  readonly reviewId: number;
}
export interface MeasurementContract {
  readonly workflowPath: string;
  readonly jobKey: string;
  readonly jobName: string;
}
export type FindingMeasurement = {
  readonly status: "unknown";
  readonly identity: FindingIdentity | null;
  readonly reason: string;
} | {
  readonly status: "producer_attested";
  readonly identity: FindingIdentity;
  readonly receipt: MeasurementV1;
  readonly checkRunId: number;
  readonly workflowJobDatabaseId: number;
  readonly workflowJobCheckRunId: number;
  readonly durations: MeasurementRow["durations"];
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function id(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value > 0; }
export function findingIdentity(value: unknown): FindingIdentity | null {
  const comment = record(value);
  const sha = record(comment?.originalCommit)?.oid;
  const reviewId = record(comment?.pullRequestReview)?.databaseId;
  return id(comment?.databaseId) && id(reviewId) && typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)
    ? { commentId: comment.databaseId, originalHeadSha: sha, reviewId } : null;
}

export function measurementOptions(argv: readonly string[]): MeasurementContract {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!["--measurement-workflow", "--measurement-job-key", "--measurement-job-name"].includes(key) || !value || values.has(key)) throw new Error("invalid measurement options");
    values.set(key, value);
  }
  const workflowPath = values.get("--measurement-workflow") ?? "";
  const jobKey = values.get("--measurement-job-key") ?? "";
  const jobName = values.get("--measurement-job-name") ?? "";
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowPath) || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(jobKey)
    || !jobName || jobName.length > 200 || Array.from(jobName).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new Error("explicit measurement workflow and job contract required");
  return { workflowPath, jobKey, jobName };
}

export function enrichAdoptionRows(rows: readonly AdoptionRow[], contract: MeasurementContract, githubRead: typeof readGithubMeasurement = readGithubMeasurement, deadline = performance.now() + 9 * 60 * 1000): AdoptionRow[] {
  let requests = 0;
  const read = (endpoint: string): unknown => {
    if (++requests > 100) throw new Error("measurement request limit");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error("measurement deadline");
    return githubRead(endpoint, Math.min(30_000, remaining));
  };
  const workflows = new Map<string, number | null>();
  const collections = new Map<string, ReturnType<typeof collectReviewMeasurements>>();
  return rows.map((row) => {
    const identity = row.measurement?.identity ?? null;
    const unknown = (reason: string): AdoptionRow => ({ ...row, measurement: { status: "unknown", identity, reason } });
    if (performance.now() >= deadline) return unknown("measurement_deadline");
    if (!identity) return unknown("missing_original_finding_identity");
    if (!workflows.has(row.repo)) {
      try {
        const workflow = record(read(`repos/${row.repo}/actions/workflows/${contract.workflowPath.split("/").at(-1)}`));
        workflows.set(row.repo, workflow?.path === contract.workflowPath && id(workflow.id) ? workflow.id : null);
      } catch { workflows.set(row.repo, null); }
    }
    const workflowId = workflows.get(row.repo);
    if (!workflowId) return unknown("workflow_contract_unavailable");
    const key = JSON.stringify([row.repo.toLowerCase(), row.pr, identity.originalHeadSha]);
    if (!collections.has(key)) collections.set(key, collectReviewMeasurements({ repository: row.repo, prNumber: row.pr,
      targetHeadSha: identity.originalHeadSha, workflowId, workflowPath: contract.workflowPath, jobKey: contract.jobKey, jobName: contract.jobName, maxPages: 3 }, read));
    const collection = collections.get(key);
    if (!collection || collection.partial) return unknown("measurement_collection_partial");
    const matches = collection.rows.filter((candidate) => candidate.measurement.inlineReviewIds.includes(identity.reviewId));
    if (matches.length !== 1) return unknown(matches.length ? "ambiguous_review_binding" : "missing_inline_review_binding");
    const match = matches[0];
    if (match.binding.status !== "producer_attested" || match.evidenceStatus !== "delivered" || match.workflowJobDatabaseId === null || match.workflowJobCheckRunId === null) return unknown("unverified_measurement_binding");
    return { ...row, measurement: { status: "producer_attested", identity, receipt: match.measurement, checkRunId: match.checkRunId,
      workflowJobDatabaseId: match.workflowJobDatabaseId, workflowJobCheckRunId: match.workflowJobCheckRunId, durations: match.durations } };
  });
}

function parseDuration(value: unknown): MeasurementRow["durations"]["pipelineMs"] {
  const item = record(value);
  if (item?.status === "unknown" && typeof item.reason === "string" && /^[a-z_]{1,80}$/.test(item.reason)) return { status: "unknown", reason: item.reason };
  if (item?.status === "observed" && typeof item.valueMs === "number" && Number.isFinite(item.valueMs) && item.valueMs >= 0 && (item.clock === "github_utc" || item.clock === "producer_monotonic")) return { status: "observed", valueMs: item.valueMs, clock: item.clock };
  throw new Error("invalid measurement duration");
}

export function parseFindingMeasurement(value: unknown): FindingMeasurement {
  const item = record(value), rawIdentity = record(item?.identity);
  const identity = rawIdentity && findingIdentity({ databaseId: rawIdentity.commentId, originalCommit: { oid: rawIdentity.originalHeadSha }, pullRequestReview: { databaseId: rawIdentity.reviewId } });
  if (item?.status === "unknown" && (item.identity === null || identity) && typeof item.reason === "string" && /^[a-z_]{1,80}$/.test(item.reason)) return { status: "unknown", identity, reason: item.reason };
  if (item?.status !== "producer_attested" || !identity || !id(item.checkRunId) || !id(item.workflowJobDatabaseId) || !id(item.workflowJobCheckRunId)) throw new Error("invalid finding measurement");
  const receipt = parseMeasurement(JSON.stringify(item.receipt));
  if (receipt.delivery !== "delivered") return { status: "unknown", identity, reason: "incomplete_delivery" };
  if (receipt.targetHeadSha !== identity.originalHeadSha || !receipt.inlineReviewIds.includes(identity.reviewId) || receipt.workflow.status !== "recorded") throw new Error("invalid historical measurement binding");
  const durations = record(item.durations);
  const pipelineMs = parseDuration(durations?.pipelineMs), jobQueueMs = parseDuration(durations?.jobQueueMs), workflowCreatedToTerminalMs = parseDuration(durations?.workflowCreatedToTerminalMs);
  const triggerToTerminalMs = parseDuration(durations?.triggerToTerminalMs), pushToTerminalMs = parseDuration(durations?.pushToTerminalMs);
  if ((pipelineMs.status === "observed" && (pipelineMs.clock !== "producer_monotonic" || receipt.pipeline.status !== "observed" || pipelineMs.valueMs !== receipt.pipeline.elapsedMs))
    || (jobQueueMs.status === "observed" && jobQueueMs.clock !== "github_utc")
    || (workflowCreatedToTerminalMs.status === "observed" && workflowCreatedToTerminalMs.clock !== "github_utc")) throw new Error("measurement clock conflict");
  if (triggerToTerminalMs.status !== "unknown" || pushToTerminalMs.status !== "unknown") throw new Error("unsupported event clock");
  return { status: "producer_attested", identity, receipt, checkRunId: item.checkRunId, workflowJobDatabaseId: item.workflowJobDatabaseId, workflowJobCheckRunId: item.workflowJobCheckRunId,
    durations: { pipelineMs, jobQueueMs, workflowCreatedToTerminalMs, triggerToTerminalMs, pushToTerminalMs } };
}

function lane(value: FindingMeasurement | undefined): string {
  if (value?.status !== "producer_attested") return "unknown";
  const { runtime, execution } = value.receipt;
  return JSON.stringify({ role: execution.role, runtime });
}
function cell(value: string): string { return value.replaceAll("|", "\\|").replace(/[\r\n]/g, " "); }
export function renderMeasurementReport(rows: readonly AdoptionRow[]): string[] {
  if (!rows.some((row) => row.measurement !== undefined)) return [];
  const matched = rows.filter((row) => row.measurement?.status === "producer_attested").length;
  const groups = new Map<string, AdoptionRow[]>();
  for (const row of rows) {
    const key = JSON.stringify([row.repo, lane(row.measurement), row.severity, row.category]);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const lines = ["## Review measurements", "", `Finding coverage: ${matched}/${rows.length} producer-attested; ${rows.length - matched} unknown. Producer claims do not attest platform identity or qualification.`,
    "Push and trigger times are unknown. Pipeline, job queue and workflow-created-to-terminal clocks remain separate. Duration samples count each check once per group.", "",
    "| repo / lane / severity / category | adoption | finding threads | pipeline ms | job queue ms | workflow-created-to-terminal ms |", "| --- | ---: | ---: | --- | --- | --- |"];
  for (const [key, group] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const addressed = group.filter((row) => row.fate === "addressed").length;
    const decided = group.filter((row) => row.fate === "addressed" || row.fate === "kept").length;
    const observations = new Map<number, Extract<FindingMeasurement, { status: "producer_attested" }>>();
    for (const row of group) if (row.measurement?.status === "producer_attested") observations.set(row.measurement.checkRunId, row.measurement);
    const clocks = (["pipelineMs", "jobQueueMs", "workflowCreatedToTerminalMs"] as const).map((clock) => {
      const values = [...observations.values()].map((entry) => entry.durations[clock]);
      const known = values.flatMap((value) => value.status === "observed" ? [value.valueMs] : []).sort((a, b) => a - b);
      const median = known.length ? (known[Math.floor((known.length - 1) / 2)] + known[Math.floor(known.length / 2)]) / 2 : null;
      return known.length ? `median ${median}; n=${known.length}; unknown=${values.length - known.length}` : "unknown";
    });
    lines.push(`| ${cell(key)} | ${decided ? `${Math.round(addressed / decided * 100)}%` : "-"} | ${group.length} | ${clocks.join(" | ")} |`);
  }
  lines.push("");
  return lines;
}
