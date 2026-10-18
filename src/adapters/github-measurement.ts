import { randomUUID } from "node:crypto";
import { parseRuntimeValue, type ReviewRuntime, type RuntimeValue } from "../shared/runtime.js";
import { isRunnerName } from "../shared/runner.js";
import type { Verdict } from "../shared/schema.js";

export const MEASUREMENT_MAX_BYTES = 8192;

type Unknown = { readonly status: "unknown" };
export type MeasurementRuntime = Unknown | ({ readonly status: "recorded" } &
  Pick<ReviewRuntime, "runner" | "model" | "effort" | "coreVersion" | "qualification">);
export type MeasurementWorkflow = Unknown | {
  readonly status: "recorded";
  readonly runId: string;
  readonly runAttempt: number;
  readonly jobKey: string;
};
export type MeasurementPipeline = Unknown | {
  readonly status: "observed";
  readonly clock: "producer_monotonic";
  readonly elapsedMs: number;
};
export interface MeasurementV1 {
  readonly schemaVersion: 1;
  readonly invocationId: string;
  readonly repository: string;
  readonly prNumber: number;
  readonly targetHeadSha: string;
  readonly workflow: MeasurementWorkflow;
  readonly execution: { readonly ordinal: 1; readonly role: "unknown" };
  readonly summaryReviewId: number | null;
  readonly inlineReviewIds: readonly number[];
  readonly runtime: MeasurementRuntime;
  readonly pipeline: MeasurementPipeline;
  readonly outcome: "verdict" | "operational_failure" | "cancelled" | "skipped" | "superseded";
  readonly verdict: Verdict | null;
  readonly delivery: "verdict_check_published" | "delivered" | "posting_failed" | "partial" | "not_applicable";
}

export function measurementWorkflow(input: {
  readonly runId: string | undefined;
  readonly runAttempt: string | undefined;
  readonly jobKey: string | undefined;
}): MeasurementWorkflow {
  if (!input.runId || !/^[1-9]\d{0,19}$/.test(input.runId) ||
      !input.runAttempt || !/^[1-9]\d{0,8}$/.test(input.runAttempt) ||
      !input.jobKey || !/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(input.jobKey)) return { status: "unknown" };
  return { status: "recorded", runId: input.runId, runAttempt: Number(input.runAttempt), jobKey: input.jobKey };
}

export function newMeasurement(input: {
  readonly repository: string;
  readonly prNumber: number;
  readonly targetHeadSha: string;
  readonly workflow: MeasurementWorkflow;
}): MeasurementV1 {
  return {
    schemaVersion: 1, invocationId: randomUUID(), ...input,
    execution: { ordinal: 1, role: "unknown" }, summaryReviewId: null, inlineReviewIds: [],
    runtime: { status: "unknown" }, pipeline: { status: "unknown" },
    outcome: "operational_failure", verdict: null, delivery: "partial",
  };
}

export function measurementRuntime(runtime: ReviewRuntime | undefined): MeasurementRuntime {
  if (!runtime) return { status: "unknown" };
  return {
    status: "recorded", runner: runtime.runner, model: { ...runtime.model },
    effort: { ...runtime.effort }, coreVersion: { ...runtime.coreVersion },
    qualification: { matchStatus: "unqualified" },
  };
}

export function measurementPipeline(start: number | null, end: number): MeasurementPipeline {
  if (start === null || !Number.isFinite(start) || !Number.isFinite(end) || end < start) return { status: "unknown" };
  return { status: "observed", clock: "producer_monotonic", elapsedMs: end - start };
}

export function measurementText(record: MeasurementV1): string | undefined {
  const text = JSON.stringify(record);
  return Buffer.byteLength(text, "utf8") <= MEASUREMENT_MAX_BYTES ? text : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid measurement object");
  return value;
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some((key) => !(key in value))) throw new Error("invalid measurement fields");
}

function positiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function runtimeValue(value: unknown, kind: "identity" | "model" = "identity"): RuntimeValue {
  const row = object(value);
  if (row.status === "unknown") { keys(row, ["status"]); return { status: "unknown" }; }
  keys(row, ["status", "value"]);
  return parseRuntimeValue(row, kind);
}

export function parseMeasurement(text: string): MeasurementV1 {
  if (Buffer.byteLength(text, "utf8") > MEASUREMENT_MAX_BYTES) throw new Error("measurement exceeds byte limit");
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error("invalid measurement JSON"); }
  const row = object(raw);
  keys(row, ["schemaVersion", "invocationId", "repository", "prNumber", "targetHeadSha", "workflow", "execution", "summaryReviewId", "inlineReviewIds", "runtime", "pipeline", "outcome", "verdict", "delivery"]);
  if (row.schemaVersion !== 1 || typeof row.invocationId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.invocationId) ||
      typeof row.repository !== "string" || !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(row.repository) || row.repository.length > 201 ||
      !positiveId(row.prNumber) || typeof row.targetHeadSha !== "string" || !/^[a-f0-9]{40}$/.test(row.targetHeadSha)) throw new Error("invalid measurement identity");
  const workflow = object(row.workflow);
  let parsedWorkflow: MeasurementWorkflow;
  if (workflow.status === "unknown") { keys(workflow, ["status"]); parsedWorkflow = { status: "unknown" }; }
  else {
    keys(workflow, ["status", "runId", "runAttempt", "jobKey"]);
    if (workflow.status !== "recorded" || typeof workflow.runId !== "string" || !positiveId(workflow.runAttempt) || typeof workflow.jobKey !== "string") throw new Error("invalid measurement workflow");
    parsedWorkflow = measurementWorkflow({ runId: workflow.runId, runAttempt: String(workflow.runAttempt), jobKey: workflow.jobKey });
    if (parsedWorkflow.status === "unknown") throw new Error("invalid measurement workflow");
  }
  const execution = object(row.execution); keys(execution, ["ordinal", "role"]);
  if (execution.ordinal !== 1 || execution.role !== "unknown") throw new Error("unsupported measurement execution");
  if (row.summaryReviewId !== null && !positiveId(row.summaryReviewId)) throw new Error("invalid measurement summary review");
  if (!Array.isArray(row.inlineReviewIds) || !row.inlineReviewIds.every(positiveId) || new Set(row.inlineReviewIds).size !== row.inlineReviewIds.length) throw new Error("invalid measurement inline reviews");
  const runtime = object(row.runtime);
  let parsedRuntime: MeasurementRuntime;
  if (runtime.status === "unknown") { keys(runtime, ["status"]); parsedRuntime = { status: "unknown" }; }
  else {
    keys(runtime, ["status", "runner", "model", "effort", "coreVersion", "qualification"]);
    const qualification = object(runtime.qualification); keys(qualification, ["matchStatus"]);
    if (runtime.status !== "recorded" || typeof runtime.runner !== "string" || !isRunnerName(runtime.runner) || qualification.matchStatus !== "unqualified") throw new Error("invalid measurement runtime");
    parsedRuntime = { status: "recorded", runner: runtime.runner, model: runtimeValue(runtime.model, "model"), effort: runtimeValue(runtime.effort), coreVersion: runtimeValue(runtime.coreVersion), qualification: { matchStatus: "unqualified" } };
  }
  const pipeline = object(row.pipeline);
  let parsedPipeline: MeasurementPipeline;
  if (pipeline.status === "unknown") { keys(pipeline, ["status"]); parsedPipeline = { status: "unknown" }; }
  else {
    keys(pipeline, ["status", "clock", "elapsedMs"]);
    if (pipeline.status !== "observed" || pipeline.clock !== "producer_monotonic" || typeof pipeline.elapsedMs !== "number" || !Number.isFinite(pipeline.elapsedMs) || pipeline.elapsedMs < 0) throw new Error("invalid measurement pipeline");
    parsedPipeline = { status: "observed", clock: "producer_monotonic", elapsedMs: pipeline.elapsedMs };
  }
  if (row.outcome !== "verdict" && row.outcome !== "operational_failure" && row.outcome !== "cancelled" && row.outcome !== "skipped" && row.outcome !== "superseded") throw new Error("invalid measurement outcome");
  if (row.verdict !== null && row.verdict !== "pass" && row.verdict !== "needs_human" && row.verdict !== "changes_requested") throw new Error("invalid measurement verdict");
  if ((row.outcome === "verdict") !== (row.verdict !== null)) throw new Error("inconsistent measurement verdict");
  if (row.delivery !== "verdict_check_published" && row.delivery !== "delivered" && row.delivery !== "posting_failed" && row.delivery !== "partial" && row.delivery !== "not_applicable") throw new Error("invalid measurement delivery");
  if ((row.delivery === "delivered" || row.delivery === "verdict_check_published") && row.outcome !== "verdict") throw new Error("inconsistent measurement delivery");
  if (row.delivery === "delivered" && row.summaryReviewId === null) throw new Error("delivered measurement has no summary review");
  return {
    schemaVersion: 1, invocationId: row.invocationId, repository: row.repository, prNumber: row.prNumber,
    targetHeadSha: row.targetHeadSha, workflow: parsedWorkflow, execution: { ordinal: 1, role: "unknown" },
    summaryReviewId: row.summaryReviewId, inlineReviewIds: row.inlineReviewIds, runtime: parsedRuntime,
    pipeline: parsedPipeline, outcome: row.outcome, verdict: row.verdict, delivery: row.delivery,
  };
}
