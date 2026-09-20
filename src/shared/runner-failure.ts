// Adapter-owned failure metadata, not model output or a routing decision.
// Only codes whose meaning is known to the adapter should receive a kind.
// In particular, ACP has no portable quota-exhausted code: never infer quota
// from an agent's prose, an arbitrary JSON-RPC code, or a generic HTTP 429.
export type RunnerFailureKind =
  | "startup_timeout"
  | "startup_failed"
  | "auth_required"
  | "permission_required"
  | "cancelled"
  | "refused"
  | "response_limit"
  | "protocol_error"
  | "unknown";

export class RunnerFailure extends Error {
  constructor(
    readonly kind: RunnerFailureKind,
    message: string,
    readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "RunnerFailure";
  }
}

// Shared lifecycle code wraps failures with Error.cause to keep its public
// RunnerOperationalError contract. Walk only actual Error instances and own
// data properties, without running getters or trusting JSON-shaped objects.
// A bounded walk also makes cyclic or hostile diagnostic chains harmless.
export function findRunnerFailure(error: unknown): RunnerFailure | undefined {
  const seen = new Set<Error>();
  for (let depth = 0; depth < 16 && error instanceof Error; depth += 1) {
    if (error instanceof RunnerFailure) return error;
    if (seen.has(error)) return undefined;
    seen.add(error);
    error = Object.getOwnPropertyDescriptor(error, "cause")?.value;
  }
  return undefined;
}
